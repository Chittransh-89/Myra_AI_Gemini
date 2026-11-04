/**
 * Myra AI — T5.0 server-side Handoff client.
 *
 * Connects over a Windows named pipe owned by the Electron main process.
 * Trust is established with a per-run nonce (first frame); after that, the
 * client may register Gemini tool calls and receive one-time tickets back.
 *
 * Design points:
 *  - Non-throwing by contract: every failure just makes `isActive()` false.
 *    Voice/audio functionality never depends on this module.
 *  - One connection attempt eager (warm), then lazy retry on demand.
 *  - No secrets are logged: nonce, tickets and digests are never printed.
 */

import net from "net";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Canonical JSON — mirrored byte-for-byte in electron/lib/ipcValidate.cjs.
// Both sides of the trust boundary must produce the SAME canonical form,
// otherwise arg digests would not verify.
// ---------------------------------------------------------------------------

const MAX_TOTAL_LENGTH = 16 * 1024;
const MAX_DEPTH = 10;
const MAX_KEYS = 128;
const MAX_ARRAY = 1024;

// Domain-separated HMAC prefix. MIRRORED in electron/lib/ipcValidate.cjs.
const COMPLETION_DOMAIN = "myra-t5r-completion-v1\u0000";

export function strictCanonicalJson(value: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) return null;
    const parts: string[] = [];
    for (const v of value) {
      const s = strictCanonicalJson(v, depth + 1);
      if (s === null) return null;
      parts.push(s);
    }
    return "[" + parts.join(",") + "]";
  }
  if (t === "object") {
    const proto = Object.getPrototypeOf(value as object);
    if (proto !== Object.prototype && proto !== null) return null;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length > MAX_KEYS) return null;
    keys.sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      const tv = typeof v;
      if (v === undefined || tv === "function" || tv === "symbol" || tv === "bigint") return null;
      const s = strictCanonicalJson(v, depth + 1);
      if (s === null) return null;
      parts.push(JSON.stringify(k) + ":" + s);
    }
    return "{" + parts.join(",") + "}";
  }
  return null; // undefined, function, symbol, bigint — unsupported
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function digestToolArgs(args: unknown): string | null {
  try {
    const canonical = strictCanonicalJson(args);
    if (canonical === null || canonical.length === 0 || canonical.length > MAX_TOTAL_LENGTH) return null;
    return crypto.createHash("sha256").update(canonical).digest("hex");
  } catch {
    return null;
  }
}

export function timingSafeEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a completion receipt's domain-separated HMAC over its canonical
 * payload (receipt minus `sig`). The receipt key is shared with the Electron
 * main process via the environment; the renderer never receives it.
 */
export function verifyCompletionHmac(receipt: unknown, receiptKeyHex: string): boolean {
  try {
    if (!receipt || typeof receipt !== "object" || typeof (receipt as any).sig !== "string") return false;
    const { sig, ...payload } = receipt as Record<string, unknown> & { sig: string };
    const canonical = strictCanonicalJson(payload);
    if (canonical === null) return false;
    const expected = crypto
      .createHmac("sha256", Buffer.from(receiptKeyHex, "hex"))
      .update(COMPLETION_DOMAIN + canonical)
      .digest("hex");
    return timingSafeEq(sig, expected);
  } catch {
    return false;
  }
}

/**
 * Windows named pipes require the \\.\pipe\ namespace. Must stay identical to
 * toPipePath() in electron/lib/handoffAuthority.cjs so both pipe ends resolve
 * to the same kernel object.
 */
function toPipePath(name: string): string {
  if (process.platform !== "win32") return name;
  return name.startsWith("\\\\.\\pipe\\") || name.startsWith("\\\\?\\pipe\\") ? name : "\\\\.\\pipe\\" + name;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type RegisterResult =
  | { outcome: "ok"; ticket: string; mainExecuted: boolean }
  | { outcome: "error"; reason: string };

export interface ToolHandoff {
  isActive(): boolean;
  /** Registers one tool call and resolves to a one-time ticket (or explicit failure). */
  registerPendingCall(callId: string, name: string, args: unknown, sessionId: string): Promise<RegisterResult>;
  dispose(): void;
}

export interface CompletionReceipt {
  v: number;
  kind: string;
  callId: string;
  toolName: string;
  sessionId: string;
  argsDigest: string;
  executionStatus: "success" | "execution_error" | "denied" | "cancelled";
  result: unknown;
  resultDigest: string | null;
  reason: string | null;
  nonce: string;
  issuedAtMs: number;
  sig: string;
}

export function createHandoffClient(opts: {
  pipeName: string;
  nonce: string;
  /** Hex receipt key shared with the Electron main process via env. */
  receiptKey: string;
  /** Invoked for HMAC-verified completion receipts pushed by the authority. */
  onCompletion: (receipt: CompletionReceipt) => void;
  /** Invoked for metadata-only execution status frames (e.g. state:"executing"). */
  onExecStatus: (frame: { callId: string; sessionId: string; state: string }) => void;
}): ToolHandoff {
  const { pipeName, nonce, receiptKey, onCompletion, onExecStatus } = opts;

  // Inbound frame limits (mirrors the pipe server's caps).
  const MAX_FRAME_BYTES = 64 * 1024;
  const MAX_BUFFER_BYTES = 256 * 1024;

  let socket: net.Socket | null = null;
  let handshakeDone = false;
  let connecting = false;
  let buffer = "";
  let disposed = false;
  let warnedUnavailable = false;

  const pendingRegistrations = new Map<
    string,
    (result: RegisterResult) => void
  >();
  const pendingConnects: Array<(ok: boolean) => void> = [];
  const retryUntil = { value: 0 };
  const REGISTER_TIMEOUT_MS = 3000;

  function informConnectWaiters(ok: boolean) {
    const waiters = pendingConnects.splice(0, pendingConnects.length);
    for (const w of waiters) {
      try {
        w(ok);
      } catch {
        /* ignore */
      }
    }
  }

  function flushBuffer() {
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.length > MAX_FRAME_BYTES) {
        teardown();
        return;
      }
      if (!line.trim()) continue;
      let frame: any;
      try {
        frame = JSON.parse(line);
      } catch {
        teardown();
        return;
      }
      if (frame && frame.type === "ticket" && typeof frame.callId === "string") {
        const resolver = pendingRegistrations.get(frame.callId);
        pendingRegistrations.delete(frame.callId);
        if (resolver) {
          resolver(
            frame.ok
              ? { outcome: "ok", ticket: String(frame.ticket), mainExecuted: frame.mainExecuted === true }
              : { outcome: "error", reason: String(frame.reason ?? "unknown") }
          );
        }
      } else if (frame && frame.type === "completion" && frame.receipt && typeof frame.receipt === "object") {
        // Trust boundary: only HMAC-verified completions reach the handler.
        if (verifyCompletionHmac(frame.receipt, receiptKey)) {
          try {
            onCompletion(frame.receipt as CompletionReceipt);
          } catch {
            /* handler errors must not kill the pipe */
          }
        } else {
          console.log("[server] [tamper] COMPLETION_BAD_SIGNATURE");
        }
      } else if (frame && frame.type === "execStatus" && typeof frame.callId === "string" && typeof frame.sessionId === "string") {
        try {
          onExecStatus({ callId: frame.callId, sessionId: frame.sessionId, state: String(frame.state ?? "") });
        } catch {
          /* ignore */
        }
      }
      // other frame types are ignored (this client is read/write minimal)
    }
  }

  function teardown() {
    handshakeDone = false;
    if (socket) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      socket = null;
    }
    for (const [callId, resolver] of pendingRegistrations) {
      resolver({ outcome: "error", reason: "handoffUnavailable" });
    }
    pendingRegistrations.clear();
    informConnectWaiters(false);
    connecting = false;
  }

  function connectOnce(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (socket && handshakeDone) return Promise.resolve(true);
    if (connecting) {
      return new Promise<boolean>((resolve) => pendingConnects.push(resolve));
    }
    connecting = true;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        connecting = false;
        informConnectWaiters(ok);
        resolve(ok);
      };
      try {
        const sock = net.connect(toPipePath(pipeName));
        socket = sock;
        const timer = setTimeout(() => {
          finish(false);
          teardown();
        }, 2500);
        sock.on("connect", () => {
          try {
            sock.write(JSON.stringify({ type: "hello", nonce }) + "\n");
          } catch {
            clearTimeout(timer);
            finish(false);
            teardown();
          }
        });
        sock.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          if (buffer.length > MAX_BUFFER_BYTES) {
            clearTimeout(timer);
            finish(false);
            teardown();
            return;
          }
          // hello reply
          if (!handshakeDone) {
            const idx = buffer.indexOf("\n");
            if (idx !== -1) {
              const line = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 1);
              let reply: any;
              try {
                reply = JSON.parse(line);
              } catch {
                clearTimeout(timer);
                finish(false);
                teardown();
                return;
              }
              if (reply && reply.type === "ok") {
                handshakeDone = true;
                clearTimeout(timer);
                finish(true);
                flushBuffer();
              } else {
                clearTimeout(timer);
                finish(false);
                teardown();
              }
            }
            return;
          }
          flushBuffer();
        });
        sock.on("error", () => {
          clearTimeout(timer);
          finish(false);
          teardown();
        });
        sock.on("close", () => {
          clearTimeout(timer);
          if (socket === sock) {
            teardown();
          }
        });
      } catch {
        finish(false);
        connecting = false;
      }
    });
  }

  return {
    isActive: () => handshakeDone && !disposed,

    async registerPendingCall(callId, name, args, sessionId): Promise<RegisterResult> {
      if (disposed) return { outcome: "error", reason: "handoffUnavailable" };
      const digest = digestToolArgs(args);
      if (!digest) return { outcome: "error", reason: "malformedArgs" };

      const alive = await connectOnce();
      if (!alive || !handshakeDone) {
        // Fail-secure: no registration, no ticket. Voice pipeline unaffected.
        if (!warnedUnavailable && Date.now() > retryUntil.value) {
          warnedUnavailable = true;
          console.log("[server] [handoff] unavailable — desktop tool registration disabled for this connection attempt");
        }
        return { outcome: "error", reason: "handoffUnavailable" };
      }
      warnedUnavailable = false;

      return new Promise<RegisterResult>((resolve, reject) => {
        if (!socket || !handshakeDone) return resolve({ outcome: "error", reason: "handoffUnavailable" });
        const timer = setTimeout(() => {
          pendingRegistrations.delete(callId);
          resolve({ outcome: "error", reason: "handoffTimeout" });
        }, REGISTER_TIMEOUT_MS);
        pendingRegistrations.set(callId, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        try {
          socket!.write(
            JSON.stringify({ type: "register", callId, toolName: name, argsDigest: digest, sessionId }) + "\n"
          );
        } catch {
          clearTimeout(timer);
          pendingRegistrations.delete(callId);
          resolve({ outcome: "error", reason: "handoffUnavailable" });
          teardown();
        }
      });
    },

    dispose() {
      disposed = true;
      teardown();
    },
  };
}
