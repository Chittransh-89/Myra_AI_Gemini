/**
 * Myra AI — T5.0/T5R Handoff Authority (main process).
 *
 * The ONLY component allowed to mint execution tickets AND authenticated
 * completions. The renderer can never mint, extend, or re-use either: the
 * ticket HMAC key never leaves this process, the completion receipt key is
 * shared only with the WS server over the environment, tickets are single-use,
 * and expiry uses the monotonic clock (process.hrtime — immune to wall-clock
 * jumps).
 *
 * Trust chain (T5R Phase B — direct completion):
 *   Gemini toolCall -> WS server -> (pipe, nonce) register{callId, toolName,
 *   argsDigest, sessionId} -> this authority -> one-time HMAC ticket -> the
 *   renderer merely TRIGGERS execution via IPC -> this authority executes the
 *   tool in main -> mints a signed completion carrying the ACTUAL result ->
 *   pushes it over the pipe -> the WS server verifies it against its own
 *   registration and forwards it to Gemini itself. The renderer never authors
 *   a Gemini-visible tool result.
 *
 * The same authority object serves BOTH server topologies (dev child process
 * over the named pipe, packaged server in-process over the same pipe).
 */

const crypto = require("crypto");
const net = require("net");
const {
  canonicalJsonOrNull,
  sha256Hex,
  hmacHex,
  timingSafeEqStrings,
  isPlainObject,
  isSafeId,
  isHex64,
  isSessionId,
  TICKET_DOMAIN,
  COMPLETION_DOMAIN,
} = require("./ipcValidate.cjs");

const DEFAULT_TICKET_TTL_MS = 20000;
// Phase C: openWebsite is now MAIN-EXECUTED (validated navigation inside the
// controlled Myra browser) and browserControl drives YouTube/page actions.
// Both are declared builtin names; nothing else may be registered.
// WhatsApp and Phone Link joined later: both are main-executed so no renderer
// code ever authors a Gemini-visible messaging result.
const EXECUTOR_NAMES = new Set(["getSystemTime", "openWebsite", "browserControl", "whatsappControl", "phoneControl", "projectControl", "fileControl"]);
const MAX_RESULT_BYTES = 8 * 1024;          // canonical result cap (receipt)
const MAX_PENDING_PER_CHANNEL = 64;         // concurrent registrations per pipe channel

// Pipe transport limits (T5R Phase B requirement 3).
const MAX_PIPE_FRAME_BYTES = 64 * 1024;     // one newline-delimited frame
const MAX_PIPE_BUFFER_BYTES = 256 * 1024;   // accumulation buffer before destroy
const MAX_FRAMES_PER_SECOND = 50;           // per-socket frame rate

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

/**
 * Windows named pipes require the \\.\pipe\ namespace. Normalising explicitly
 * (instead of relying on libuv defaults) keeps server and client identical.
 */
function toPipePath(name) {
  if (process.platform !== "win32") return name;
  return name.startsWith("\\\\.\\pipe\\") || name.startsWith("\\\\?\\pipe\\") ? name : "\\\\.\\pipe\\" + name;
}

function createHandoffAuthority({ audit, killSwitch, receiptKey, emitCompletion, notifyExecuting, browser, whatsapp, phone, project, file }) {
  const hmacKey = crypto.randomBytes(32); // ticket key — never leaves this process, never logged
  if (!Buffer.isBuffer(receiptKey) || receiptKey.length === 0) {
    throw new Error("createHandoffAuthority: receiptKey (Buffer) is required for completion signing");
  }
  const emit = typeof emitCompletion === "function" ? emitCompletion : () => false;
  const notifyExec = typeof notifyExecuting === "function" ? notifyExecuting : () => {};

  const pending = new Map(); // callId -> entry
  const executors = new Map([
    // Harmless local clock read (end-to-end validation tool).
    [
      "getSystemTime",
      () => {
        const now = new Date();
        return {
          time: now.toLocaleTimeString(),
          date: now.toLocaleDateString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          executedIn: "main-process",
        };
      },
    ],
  ]);

  // Phase C desktop executors. They exist ONLY when a browser controller was
  // injected, so a mis-configured main process fails closed (registration is
  // rejected as unknownToolName => the server synthesizes an error) instead of
  // advertising a capability it cannot honour.
  if (browser && typeof browser.open === "function") {
    executors.set("openWebsite", (args) => browser.open(args && args.url));
  }
  if (browser && typeof browser.run === "function") {
    executors.set("browserControl", (args) => browser.run(args));
  }
  // Messaging bridges. Same rule: only registered when the capability exists.
  if (whatsapp && typeof whatsapp.status === "function") {
    executors.set("whatsappControl", (args) => {
      const action = args && args.action;
      if (action === "status") return whatsapp.status();
      if (action === "prepare") return whatsapp.prepare(args);
      if (action === "send") return whatsapp.send(args);
      return { ok: false, sent: false, error: "unsupportedAction" };
    });
  }
  if (phone && typeof phone.status === "function") {
    executors.set("phoneControl", (args) => {
      const action = args && args.action;
      if (action === "status") return phone.status();
      if (action === "open") return phone.open();
      return { ok: false, error: "unsupportedAction" };
    });
  }
  // VS Code project builder. Filesystem work stays in main; the renderer only
  // triggers it. Every apply is bound to a planId minted by plan().
  if (project && typeof project.plan === "function") {
    executors.set("projectControl", (args) => {
      const action = args && args.action;
      if (action === "detect") return project.detect();
      if (action === "reference") return project.reference(args);
      if (action === "plan") return project.plan(args);
      if (action === "apply") return project.apply(args);
      if (action === "edit") return project.edit(args);
      return { ok: false, error: "unsupportedAction" };
    });
  }
  // File reading. Main-process only: the renderer never receives fs access and
  // every read requires a user authorization recorded in this session.
  if (file && typeof file.run === "function") {
    executors.set("fileControl", (args) => file.run(args));
  }
  let generation = 0; // bumped by the kill switch; stale async completions are suppressed
  const stats = {
    registered: 0, consumed: 0, denied: 0, deniedByReason: {},
    completionsEmitted: 0, completionsUndelivered: 0, completionsSuppressed: 0,
  };

  function denied(reason) {
    stats.denied++;
    stats.deniedByReason[reason] = (stats.deniedByReason[reason] || 0) + 1;
    return { status: "denied", reason };
  }

  /** Lazily prune expired entries so the registry cannot grow unbounded. */
  function sweepExpired() {
    const now = process.hrtime.bigint();
    for (const [id, e] of pending) {
      if (now > e.deadlineNs) pending.delete(id);
    }
  }

  /**
   * Mint a domain-separated completion receipt carrying the ACTUAL result and
   * push it to the WS server over the authenticated pipe. `emit` reports
   * delivery; undelivered completions are audited and discarded (the server
   * will time its registration out — never an unauthenticated fallback).
   */
  function mintAndEmitCompletion(entry, executionStatus, result, reason) {
    try {
      let finalStatus = executionStatus;
      let finalResult = result === undefined ? null : result;
      let resultDigest = null;
      if (finalStatus === "success" || finalStatus === "execution_error") {
        const canonical = canonicalJsonOrNull(finalResult, MAX_RESULT_BYTES);
        if (canonical === null) {
          // Strict validation rejected the executor output — degrade to a
          // safe, strictly-valid error result rather than shipping it raw.
          audit("COMPLETION_RESULT_INVALID", { callId: entry.callId, tool: entry.toolName });
          finalStatus = "execution_error";
          finalResult = { error: "executorOutputInvalid" };
        }
        resultDigest = sha256Hex(canonicalJsonOrNull(finalResult, MAX_RESULT_BYTES));
      }
      const receipt = {
        v: 1,
        kind: "completion",
        callId: entry.callId,
        toolName: entry.toolName,
        sessionId: entry.sessionId,
        argsDigest: entry.argsDigest,
        executionStatus: finalStatus,
        result: finalResult,
        resultDigest,
        reason: reason === undefined ? null : reason,
        nonce: crypto.randomBytes(16).toString("hex"),
        issuedAtMs: Date.now(), // INFORMATIONAL ONLY — never a validity input
      };
      const canonical = canonicalJsonOrNull(receipt, 16 * 1024);
      if (canonical === null) {
        audit("COMPLETION_MINT_ERROR", { callId: entry.callId, reason: "canonicalization" });
        return;
      }
      receipt.sig = hmacHex(receiptKey, COMPLETION_DOMAIN, canonical);
      entry.state = "consumed";
      stats.completionsEmitted++;
      const delivered = emit({ type: "completion", receipt });
      if (!delivered) {
        stats.completionsUndelivered++;
        audit("COMPLETION_UNDELIVERED", { callId: entry.callId, reason: "pipeDown" });
      }
    } catch (err) {
      audit("COMPLETION_MINT_ERROR", { callId: String(entry && entry.callId ? entry.callId : ""), reason: "exception" });
    }
  }

  /** Denials that had registry context still close the loop server-side. */
  function emitDeniedFor(entry, reason) {
    if (entry && executors.has(entry.toolName)) {
      mintAndEmitCompletion(entry, "denied", null, reason);
    }
  }

  // Server-side registration (trusted: pipe handshake with nonce, or in-process call).
  // The pipe frame carries a pre-computed argsDigest from the WS server; the
  // in-process path (smoke) may pass raw `args` instead. Exactly one is used.
  function registerPendingCall({ callId, toolName, name, args, argsDigest, sessionId, maxAgeMs = DEFAULT_TICKET_TTL_MS, channelId = "local" }) {
    try {
      const tool = typeof toolName === "string" ? toolName : name; // compat alias for in-process callers
      if (killSwitch.isActive()) {
        audit("TOOL_REGISTRATION_BLOCKED", { callId, tool, reason: "killSwitchActive" });
        return { ok: false, reason: "killSwitchActive" };
      }
      if (!isSafeId(callId)) return { ok: false, reason: "malformedCallId" };
      if (typeof tool !== "string" || !EXECUTOR_NAMES.has(tool)) {
        return { ok: false, reason: "unknownToolName" };
      }
      if (!isSessionId(sessionId)) return { ok: false, reason: "malformedSessionId" };
      if (pending.has(callId)) return { ok: false, reason: "duplicateCallId" };
      sweepExpired();
      let channelCount = 0;
      for (const e of pending.values()) if (e.channelId === channelId) channelCount++;
      if (channelCount >= MAX_PENDING_PER_CHANNEL) {
        audit("TOOL_REGISTRATION_BLOCKED", { callId, tool, reason: "channelSaturated" });
        return { ok: false, reason: "channelSaturated" };
      }
      let digest = null;
      if (isHex64(argsDigest)) {
        digest = argsDigest; // trusted: arrived over the nonce-gated pipe
      } else {
        if (!isPlainObject(args)) args = {};
        const canonical = canonicalJsonOrNull(args, 16 * 1024);
        if (canonical === null) return { ok: false, reason: "malformedArgs" };
        digest = sha256Hex(canonical);
      }
      const ttl = Number.isFinite(maxAgeMs) ? Math.min(Math.max(maxAgeMs, 250), 60000) : DEFAULT_TICKET_TTL_MS;
      const expNs = process.hrtime.bigint() + BigInt(Math.round(ttl) * 1000000); // monotonic deadline
      const expNsString = expNs.toString();
      const payload = {
        v: 1,
        kind: "ticket",
        callId,
        toolName: tool,
        argsDigest: digest,
        sessionId,
        expNs: expNsString,
      };
      const canonicalPayload = canonicalJsonOrNull(payload, 4096);
      if (canonicalPayload === null) return { ok: false, reason: "internalError" };
      const sig = hmacHex(hmacKey, TICKET_DOMAIN, canonicalPayload);
      const ticket = b64url(Buffer.from(JSON.stringify({ ...payload, sig })));
      pending.set(callId, {
        callId,
        toolName: tool,
        argsDigest: digest,
        sessionId,
        deadlineNs: expNs,
        expNsString,
        generation,
        channelId,
        state: "registered",
      });
      stats.registered++;
      audit("TOOL_REGISTERED", { callId, tool, argsDigest: digest, ttlMs: ttl });
      return { ok: true, ticket, mainExecuted: executors.has(tool) };
    } catch (err) {
      audit("TOOL_REGISTRATION_ERROR", { callId: String(callId ?? ""), reason: "exception" });
      return { ok: false, reason: "internalError" };
    }
  }

  // Renderer-side execution request. `payload` is UNTRUSTED. The renderer only
  // TRIGGERS execution; the result is delivered to the server via the signed
  // completion channel, never through this reply.
  function handleExecuteTool(payload) {
    try {
      if (!isPlainObject(payload)) return denied("malformed");
      const { ticket, name, args } = payload;
      if (typeof ticket !== "string" || ticket.length === 0 || ticket.length > 8192) return denied("malformed");

      let parsed;
      try {
        parsed = JSON.parse(fromB64url(ticket));
      } catch {
        return denied("malformed");
      }
      if (
        !isPlainObject(parsed) ||
        parsed.v !== 1 ||
        parsed.kind !== "ticket" ||
        typeof parsed.callId !== "string" ||
        typeof parsed.toolName !== "string" ||
        typeof parsed.argsDigest !== "string" ||
        typeof parsed.sessionId !== "string" ||
        typeof parsed.expNs !== "string" ||
        typeof parsed.sig !== "string"
      ) {
        audit("TICKET_DENIED", { reason: "forged", tool: name });
        return denied("forged");
      }

      // 1) cryptography: domain-separated HMAC over the canonical payload
      const { sig, ...payloadFields } = parsed;
      const canonicalPayload = canonicalJsonOrNull(payloadFields, 4096);
      const expectedSig = canonicalPayload === null ? null : hmacHex(hmacKey, TICKET_DOMAIN, canonicalPayload);
      if (expectedSig === null || !timingSafeEqStrings(parsed.sig, expectedSig)) {
        audit("TICKET_DENIED", { callId: parsed.callId, tool: name, reason: "forged" });
        return denied("forged");
      }

      // 2) name binding: the presented tool name must equal the signed name
      if (name !== parsed.toolName) {
        audit("TICKET_DENIED", { callId: parsed.callId, tool: name, reason: "nameMismatch" });
        return denied("nameMismatch");
      }

      // 3) kill switch (sig passed, so this is a real, registered call)
      if (killSwitch.isActive()) {
        audit("EXECUTE_BLOCKED", { callId: parsed.callId, tool: name, reason: "killSwitchActive" });
        return denied("killSwitchActive");
      }

      // 4) registry membership: only freshly-registered entries may execute
      const entry = pending.get(parsed.callId);
      if (!entry || entry.state !== "registered") {
        audit("TICKET_DENIED", { callId: parsed.callId, tool: name, reason: "replay" });
        return denied("replay");
      }

      // 5) full binding: tool name, args digest, session AND exact expiry
      if (
        entry.toolName !== parsed.toolName ||
        !timingSafeEqStrings(entry.argsDigest, parsed.argsDigest) ||
        entry.sessionId !== parsed.sessionId ||
        parsed.expNs !== entry.expNsString
      ) {
        pending.delete(parsed.callId);
        emitDeniedFor(entry, "registryMismatch");
        audit("TICKET_DENIED", { callId: parsed.callId, tool: name, reason: "registryMismatch" });
        return denied("registryMismatch");
      }

      // 6) expiry (monotonic, main's own clock domain)
      if (process.hrtime.bigint() > entry.deadlineNs) {
        pending.delete(parsed.callId);
        emitDeniedFor(entry, "expired");
        audit("TICKET_DENIED", { callId: parsed.callId, tool: name, reason: "expired" });
        return denied("expired");
      }

      // 7) exact argument digest: renderer-supplied args must hash to the
      //    registered digest byte-for-byte.
      const canonicalArgs = canonicalJsonOrNull(args, 16 * 1024);
      if (canonicalArgs === null) return denied("malformedArgs");
      if (!timingSafeEqStrings(sha256Hex(canonicalArgs), entry.argsDigest)) {
        pending.delete(parsed.callId);
        emitDeniedFor(entry, "argsTampered");
        audit("EXECUTE_DENIED", { callId: parsed.callId, tool: name, reason: "argsTampered" });
        return denied("argsTampered");
      }

      // 8) executor availability. Tools without a main executor (openWebsite
      //    in Phase B) are renderer-executed; the renderer owns the response,
      //    so NO completion is emitted for them.
      const executor = executors.get(entry.toolName);
      if (!executor) {
        pending.delete(parsed.callId);
        audit("EXECUTE_DENIED", { callId: parsed.callId, tool: name, reason: "executorUnavailable" });
        return denied("executorUnavailable");
      }

      // 9) atomic single-use transition — synchronous, before any await/exec.
      entry.state = "executing";
      entry.generation = generation;
      notifyExec(entry.callId, entry.sessionId); // -> toolStatus{state:"executing"} (metadata only)

      const suppress = (why) => {
        entry.state = "suppressed";
        stats.completionsSuppressed++;
        audit("COMPLETION_SUPPRESSED", { callId: entry.callId, reason: why });
      };

      let output;
      try {
        output = executor(args);
      } catch (err) {
        audit("EXECUTE_ERROR", { callId: entry.callId, tool: entry.toolName, reason: "executorThrow" });
        mintAndEmitCompletion(entry, "execution_error", { error: "executorError" }, null);
        pending.delete(entry.callId);
        return { status: "error", reason: "executorError" };
      }

      if (output && typeof output.then === "function") {
        // Async executor (Phase F: openWebsite). The completion is emitted on
        // settle; a stale generation or cancelRequested suppresses it.
        output.then(
          (value) => {
            if (entry.state !== "executing" || entry.generation !== generation) {
              suppress("staleGenerationOrCancelled");
            } else {
              stats.consumed++;
              audit("EXECUTE_ALLOWED", { callId: entry.callId, tool: entry.toolName, argsDigest: entry.argsDigest });
              mintAndEmitCompletion(entry, "success", value, null);
            }
            pending.delete(entry.callId);
          },
          () => {
            if (entry.state !== "executing" || entry.generation !== generation) {
              suppress("staleGenerationOrCancelled");
            } else {
              audit("EXECUTE_ERROR", { callId: entry.callId, tool: entry.toolName, reason: "executorRejected" });
              mintAndEmitCompletion(entry, "execution_error", { error: "executorError" }, null);
            }
            pending.delete(entry.callId);
          }
        );
        // The IPC reply is an ACK only for async executors; the result flows
        // exclusively through the signed completion channel.
        return { status: "accepted" };
      }

      // Synchronous executor: complete in the same tick.
      stats.consumed++;
      audit("EXECUTE_ALLOWED", { callId: entry.callId, tool: entry.toolName, argsDigest: entry.argsDigest });
      mintAndEmitCompletion(entry, "success", output, null);
      pending.delete(entry.callId);
      return { status: "ok", output };
    } catch (err) {
      audit("EXECUTE_ERROR", { reason: "internal" });
      return { status: "error", reason: "internalError" };
    }
  }

  function abortPending(reason) {
    const ids = [...pending.keys()];
    pending.clear();
    if (ids.length) {
      audit("PENDING_ABORTED", { callId: ids.join(","), reason });
    }
    return ids.length;
  }

  return {
    registerPendingCall,
    handleExecuteTool,
    abortPending,
    advanceGeneration: () => {
      generation++;
      return generation;
    },
    has: (callId) => pending.has(callId),
    stats: () => stats,
    pendingCount: () => pending.size,
  };
}

// ---------------------------------------------------------------------------
// Trusted pipe: nonce-gated named-pipe transport used by the WS server
// (dev child process AND packaged in-process server) to reach this authority.
// T5R Phase B: bidirectional — the authority pushes completions and execution
// status back down the authenticated socket. Frame sizes, buffer growth and
// frame rates are hard-capped; violations destroy the connection.
// NOTE: the nonce proves knowledge of a per-run secret; it does NOT
// authenticate the connecting process's identity (platform limitation).
// ---------------------------------------------------------------------------

function createHandoffPipeServer({ pipeName, nonce, authority, audit }) {
  let state = "starting"; // starting | listening | error
  const authenticated = new Set();
  let channelSeq = 0;

  const server = net.createServer((socket) => {
    let handshakeComplete = false;
    let buffer = "";
    let rateBucket = Math.floor(Date.now() / 1000);
    let frameCount = 0;
    const channelId = "chan-" + ++channelSeq;

    const destroy = () => {
      try {
        socket.destroy();
      } catch {}
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_PIPE_BUFFER_BYTES) return destroy();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length > MAX_PIPE_FRAME_BYTES) return destroy();
        if (!line.trim()) continue;

        const nowBucket = Math.floor(Date.now() / 1000);
        if (nowBucket !== rateBucket) {
          rateBucket = nowBucket;
          frameCount = 0;
        }
        if (++frameCount > MAX_FRAMES_PER_SECOND) {
          audit("HANDOFF_PIPE_RATE_LIMITED", {});
          return destroy();
        }

        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          return destroy();
        }

        if (!handshakeComplete) {
          if (
            frame &&
            frame.type === "hello" &&
            typeof frame.nonce === "string" &&
            frame.nonce.length <= 128 &&
            timingSafeEqStrings(frame.nonce, nonce)
          ) {
            handshakeComplete = true;
            authenticated.add(socket);
            audit("HANDOFF_PIPE_HELLO_OK", {});
            try {
              socket.write(JSON.stringify({ type: "ok" }) + "\n");
            } catch {}
          } else {
            audit("HANDOFF_PIPE_HELLO_REJECTED", {});
            return destroy();
          }
          continue;
        }

        if (frame && frame.type === "register") {
          // Protocol string limits (T5R Phase B requirement 3).
          if (
            typeof frame.callId !== "string" ||
            !isSafeId(frame.callId) ||
            typeof frame.toolName !== "string" ||
            frame.toolName.length < 1 ||
            frame.toolName.length > 64 ||
            !isSessionId(frame.sessionId) ||
            !isHex64(frame.argsDigest)
          ) {
            return destroy(); // malformed protocol frame — fail closed
          }
          const result = authority.registerPendingCall({
            callId: frame.callId,
            toolName: frame.toolName,
            argsDigest: frame.argsDigest,
            sessionId: frame.sessionId,
            channelId,
          });
          const reply = result.ok
            ? { type: "ticket", callId: frame.callId, ok: true, ticket: result.ticket, mainExecuted: result.mainExecuted === true }
            : { type: "ticket", callId: frame.callId, ok: false, reason: result.reason };
          try {
            socket.write(JSON.stringify(reply) + "\n");
          } catch {
            /* client gone */
          }
        } else {
          return destroy(); // unknown frame type after handshake
        }
      }
      if (buffer.indexOf("\n") === -1 && buffer.length > MAX_PIPE_FRAME_BYTES) return destroy();
    });
    socket.on("error", () => {
      /* normal for dropped clients */
    });
    socket.on("close", () => {
      authenticated.delete(socket);
      // T5R note: full ticket revocation for this channel lands in Phase C/E.
    });
  });

  server.on("error", (err) => {
    state = "error";
    audit("HANDOFF_PIPE_ERROR", { reason: "serverError" });
    // Logged without details; the pipe name/nonce are never printed.
    console.error("[electron-main] Handoff pipe server error — desktop tool handoff unavailable this run.");
  });

  server.listen(toPipePath(pipeName), () => {
    state = "listening";
    audit("HANDOFF_PIPE_LISTENING", { pipeState: "listening" });
  });

  return {
    close: () => {
      try {
        server.close(() => {});
      } catch {}
    },
    state: () => state,
    /**
     * Push a frame to every authenticated server socket (completion/execStatus
     * direction). Returns true when at least one authenticated socket received
     * it. Outbound frames are also size-capped.
     */
    broadcast: (frame) => {
      let text;
      try {
        text = JSON.stringify(frame) + "\n";
      } catch {
        return false;
      }
      if (text.length > MAX_PIPE_FRAME_BYTES) return false;
      let delivered = false;
      for (const s of authenticated) {
        try {
          s.write(text);
          delivered = true;
        } catch {}
      }
      return delivered;
    },
    /**
     * Destroy every authenticated pipe socket (smoke harness only — simulates
     * a pipe outage so the server-side handoff client goes inactive). The
     * listener keeps accepting new connections until close() is called.
     */
    dropClients: () => {
      let n = 0;
      for (const s of authenticated) {
        try {
          s.destroy();
          n++;
        } catch {}
      }
      return n;
    },
  };
}

module.exports = {
  createHandoffAuthority,
  createHandoffPipeServer,
  DEFAULT_TICKET_TTL_MS,
  toPipePath,
  MAX_PIPE_FRAME_BYTES,
  MAX_PIPE_BUFFER_BYTES,
  MAX_FRAMES_PER_SECOND,
  MAX_PENDING_PER_CHANNEL,
};
