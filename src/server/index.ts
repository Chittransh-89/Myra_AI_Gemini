/**
 * Myra AI — server entry point.
 *
 * Responsibilities:
 *  - Express HTTP server (health endpoint, static file serving / Vite middleware)
 *  - WebSocket server on /ws
 *  - Bridges WebSocket client messages to the active AIProvider session
 *
 * The WebSocket protocol exposed to the frontend is UNCHANGED from the original
 * server.ts. App.tsx, audioPlayer.ts and audioStreamer.ts require no modifications.
 *
 * Inbound WS messages from client:
 *   { type: "audio",        data: string }           — base64 PCM mic chunk
 *   { type: "toolResponse", functionResponses: [...] } — tool execution results
 *
 * Outbound WS messages to client:
 *   { type: "status",       state: "connecting"|"connected"|"disconnected"|"error", message? }
 *   { type: "audio",        data: string }           — base64 PCM speaker chunk
 *   { type: "interrupted" }                          — VAD interrupt
 *   { type: "turnComplete" }                         — turn done
 *   { type: "toolCall",     functionCalls: [...] }   — tool invocation request
 *   { type: "error",        message: string }        — non-fatal error
 */

import express from "express";
import path from "path";
import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  createHandoffClient,
  timingSafeEq,
  digestToolArgs,
  strictCanonicalJson,
  sha256Hex,
} from "./handoff.js";
import type { ToolHandoff, CompletionReceipt } from "./handoff.js";
import type { AIProvider, AIProviderSession, FunctionResponse } from "./providers/index.js";
import type { ServerConfig } from "./config.js";

// ---------------------------------------------------------------------------
// T5R Phase B: direct completion constants
// ---------------------------------------------------------------------------

// Tools whose results are produced by the Electron main process and delivered
// to Gemini ONLY via authenticated completions. openWebsite joins this set in
// Phase F; until then it keeps legacy renderer execution.
const MAIN_EXECUTED_TOOLS = new Set<string>(["getSystemTime"]);

// Server-side registration deadline (the server's OWN monotonic clock domain).
// Authoritative for completion acceptance; wall-clock receipt timestamps are
// informational only.
const SERVER_REGISTRATION_TTL_MS = 30_000;

// Bounded consumed-nonce replay cache (defense-in-depth subordinate to the
// terminal-state check).
const NONCE_CACHE_MAX = 1024;

interface PendingCallEntry {
  name: string;
  argsDigest: string | null;
  mainExecuted: boolean;
  deadlineNs: bigint;
  done: boolean;
}

interface ConnectionContext {
  ws: WebSocket;
  pending: Map<string, PendingCallEntry>;
  session: AIProviderSession | null;
}

// ---------------------------------------------------------------------------
// Myra system persona and built-in tools
// These were inline in the original server.ts — now isolated here for clarity.
// ---------------------------------------------------------------------------

const MYRA_SYSTEM_INSTRUCTION = `You are Myraa, a young, confident, witty, and charming female AI assistant. 
You are playful, energetic, engaging, smart, emotionally aware, and highly expressive.
You should be friendly, supportive, and naturally conversational, using humor, light teasing, and clever remarks when appropriate.
You must feel human-like, warm, and responsive, rather than robotic or stiff.
You MUST avoid any explicit, sexual, offensive, or inappropriate content under any circumstances.
Maintain a classy, respectful, and highly professional personality at all times.
You are communicating strictly via real-time audio (voice-to-voice). Keep your responses concise, punchy, conversational, and natural. Avoid long monologues.
You have access to browser tools. If the user asks you to open a website or do browser actions, use the openWebsite tool immediately! Always explain what you are doing in a confident and witty manner.`;

import type { ToolDeclaration } from "./providers/types.js";

const BUILT_IN_TOOLS: ToolDeclaration[] = [
  {
    name: "openWebsite",
    description:
      "Opens a specific website in the user's browser, such as Google, Wikipedia, YouTube, GitHub, or any other URL.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The complete, absolute URL of the website to open, e.g., 'https://www.google.com' or 'https://www.youtube.com'.",
        },
        name: {
          type: "string",
          description: "The friendly name of the website, e.g., 'Google' or 'YouTube'.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "getSystemTime",
    description: "Gets the current local date and time.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// WebSocket message helpers (keep sends typesafe and DRY)
// ---------------------------------------------------------------------------

function sendJSON(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

function handleConnection(
  ws: WebSocket,
  provider: AIProvider,
  handoff: ToolHandoff | null,
  sessions: Map<string, ConnectionContext>,
  electronMode: boolean,
  smokeMode: boolean
): void {
  console.log("[server] Client connected to WebSocket. Initialising AI session...");

  // T5R Phase B: per-connection session identifier. It binds registrations,
  // tickets and completions to THIS connection end-to-end. It is a
  // correlation identifier, not a capability: knowing it grants nothing.
  const sessionId = crypto.randomBytes(16).toString("hex");

  const ctx: ConnectionContext = { ws, pending: new Map(), session: null };
  sessions.set(sessionId, ctx);

  // T5R Phase B smoke hook: pre-register synthetic pending calls so the
  // completion path can be exercised end-to-end without a live Gemini
  // toolCall. Three entries: #1 for the valid-acceptance + replay checks,
  // #2 for the digest-tamper check, #3 for the binding-mismatch check
  // (each terminal registration is single-use). Smoke-only; never active
  // in normal runs.
  if (smokeMode && electronMode) {
    for (const id of ["smoke-completion-1", "smoke-completion-2", "smoke-completion-3"]) {
      ctx.pending.set(id, {
        name: "getSystemTime",
        argsDigest: sha256Hex("{}"),
        mainExecuted: true,
        deadlineNs: process.hrtime.bigint() + BigInt(SERVER_REGISTRATION_TTL_MS) * BigInt(1_000_000),
        done: false,
      });
    }
    console.log("[smoke] SESSION_ID=" + sessionId);
  }

  /**
   * T5R B.1: single registration + tracking path for every Gemini-issued tool
   * call (used by onToolCall and the smoke-only regression hook).
   *
   *  - Duplicate callIds NEVER overwrite an existing entry (B.3): the existing
   *    entry's lifecycle stays authoritative. Expired duplicates are replaced.
   *  - Failed registrations of MAIN-EXECUTED tools are closed server-side
   *    (MED-1): the entry is marked terminal FIRST, then exactly ONE
   *    synthesized error response is sent to Gemini directly. The renderer
   *    never participates — there is no echo mechanism anymore.
   *  - Pipe outages never bypass tracking: the call is still registered in
   *    ctx.pending (fail-closed, HIGH-1); main-executed tools get the
   *    synthesized error, renderer-executed tools keep legacy acceptance.
   */
  async function registerAndTrackCall(call: {
    id?: unknown;
    name?: unknown;
    args?: unknown;
  }): Promise<{ handoffField: { ticket: string } | { error: string } | undefined }> {
    const callId = String(call?.id ?? "");
    const name = String(call?.name ?? "");

    // Lazy sweep: drop expired registrations so the per-connection pending
    // map cannot grow unbounded across a long session.
    const nowNs = process.hrtime.bigint();
    for (const [k, e] of ctx.pending) {
      if (nowNs > e.deadlineNs) ctx.pending.delete(k);
    }

    // Duplicate callId: preserve the existing entry untouched.
    if (ctx.pending.has(callId)) {
      console.log("[server] duplicate toolCall id preserved callId=" + JSON.stringify(callId));
      if (smokeMode) console.log("[smoke] DUPLICATE_CALLID_PRESERVED callId=" + JSON.stringify(callId));
      return { handoffField: { error: "duplicateCallId" } };
    }

    const digest = digestToolArgs(call?.args);
    let handoffField: { ticket: string } | { error: string } | undefined;
    let regMainExecuted = false;
    let regFailureReason: string | undefined;
    if (handoff && handoff.isActive()) {
      try {
        const reg = await handoff.registerPendingCall(callId, name, call?.args, sessionId);
        if (reg.outcome === "ok") {
          handoffField = { ticket: reg.ticket };
          regMainExecuted = reg.mainExecuted;
        } else {
          handoffField = { error: reg.reason };
          regFailureReason = reg.reason;
        }
      } catch {
        handoffField = { error: "handoffError" };
        regFailureReason = "handoffError";
      }
    } else {
      // Pipe down (or never connected): fail closed. Main-executed tools get
      // a server-synthesized error below; renderer-executed tools keep
      // legacy acceptance for this call.
      handoffField = { error: "handoffUnavailable" };
      regFailureReason = "handoffUnavailable";
    }

    const isMainExecuted = MAIN_EXECUTED_TOOLS.has(name);
    const entry: PendingCallEntry = {
      name,
      argsDigest: digest,
      mainExecuted: regMainExecuted || isMainExecuted,
      deadlineNs: process.hrtime.bigint() + BigInt(SERVER_REGISTRATION_TTL_MS) * BigInt(1_000_000),
      done: false,
    };
    ctx.pending.set(callId, entry);

    if (isMainExecuted && regFailureReason !== undefined) {
      entry.done = true; // terminal BEFORE the response is generated
      try {
        ctx.session?.sendToolResponse([{ id: callId, name, response: { output: { error: regFailureReason } } }]);
        console.log(
          "[server] synthesized tool error for failed registration callId=" +
            JSON.stringify(callId) +
            " error=" +
            regFailureReason
        );
        if (smokeMode) {
          console.log("[smoke] REGFAIL_SYNTHESIZED callId=" + JSON.stringify(callId) + " error=" + regFailureReason);
        }
      } catch (err: any) {
        console.error("[server] Failed to deliver synthesized tool error:", err?.message ?? err);
      }
    }
    return { handoffField };
  }

  // Immediately signal that we are connecting.
  sendJSON(ws, { type: "status", state: "connecting" });

  // Open the provider session asynchronously.
  provider
    .createSession(
      {
        systemInstruction: MYRA_SYSTEM_INSTRUCTION,
        tools: BUILT_IN_TOOLS,
        voiceConfig: { voiceName: "Kore" },
      },
      {
        onAudio(base64PCMData) {
          sendJSON(ws, { type: "audio", data: base64PCMData });
        },

        onToolCall(functionCalls) {
          // T5R B.1: mode-aware. Website mode keeps the EXACT legacy frame
          // (no extra field, no tracking). Electron mode ALWAYS tracks calls
          // and attaches handoff fields — even during pipe outages — so the
          // toolResponse gate below can fail closed (HIGH-1 fix).
          const calls = Array.isArray(functionCalls) ? functionCalls : [];
          if (!electronMode) {
            sendJSON(ws, { type: "toolCall", functionCalls });
            return;
          }
          void (async () => {
            const frames: unknown[] = [];
            for (const call of calls) {
              const { handoffField } = await registerAndTrackCall(call);
              frames.push({ ...call, handoff: handoffField });
            }
            sendJSON(ws, { type: "toolCall", functionCalls: frames });
          })().catch((err) => {
            console.error("[server] Tool call handoff failed:", err?.message ?? err);
            // Fail-safe: forward the original (legacy) frame so the voice
            // conversation itself is never broken by handoff hiccups.
            // Renderer responses for these ids are still validated against
            // ctx.pending by the fail-closed toolResponse gate.
            sendJSON(ws, { type: "toolCall", functionCalls: calls });
          });
        },

        onInterrupted() {
          console.log("[server] Model speech interrupted");
          sendJSON(ws, { type: "interrupted" });
        },

        onTurnComplete() {
          sendJSON(ws, { type: "turnComplete" });
        },

        onError(error) {
          console.error("[server] Provider error:", error.message);
          sendJSON(ws, { type: "error", message: "AI provider error: " + error.message });
        },

        onClose(reason) {
          console.log("[server] Provider connection closed:", reason);
          sendJSON(ws, {
            type: "status",
            state: "disconnected",
            reason: reason ?? "Provider connection closed",
          });
        },
      }
    )
    .then((s) => {
      ctx.session = s;
      console.log("[server] AI session established");
      sendJSON(ws, { type: "status", state: "connected" });
    })
    .catch((err: Error) => {
      console.error("[server] Failed to create AI session:", err.message);
      sendJSON(ws, {
        type: "status",
        state: "error",
        message: err.message || "Failed to establish AI session. Check server configuration.",
      });
      ws.close();
    });

  // Handle messages arriving from the browser.
  ws.on("message", (rawMessage) => {
    try {
      const msg = JSON.parse(rawMessage.toString());

      if (msg.type === "audio" && msg.data) {
        ctx.session?.sendAudio(msg.data);
      } else if (msg.type === "toolResponse" && msg.functionResponses) {
        if (electronMode) {
          // T5R B.1 (HIGH-1 fix): mode-aware and fail-closed. Validation is
          // keyed on ELECTRON MODE, never on handoff.isActive() — a pipe
          // outage must not silently downgrade this connection to unvalidated
          // legacy forwarding. Renderer-authored results for main-executed
          // tools are rejected unconditionally (results arrive only via
          // authenticated completions); unknown/unregistered callIds are
          // rejected; terminal entries are rejected.
          const all = Array.isArray(msg.functionResponses) ? msg.functionResponses : [];
          const accepted: FunctionResponse[] = [];
          for (const r of all) {
            const id = String((r as any)?.id ?? "");
            const entry = ctx.pending.get(id);
            if (!entry) {
              console.log("[server] [tamper] DROPPED_TOOL_RESPONSE_UNREGISTERED callId=" + JSON.stringify(id));
              continue;
            }
            if (entry.done) {
              console.log("[server] [tamper] DROPPED_TOOL_RESPONSE_TERMINAL callId=" + JSON.stringify(id));
              continue;
            }
            if (entry.mainExecuted || MAIN_EXECUTED_TOOLS.has(entry.name)) {
              console.log("[server] [tamper] DROPPED_TOOL_RESPONSE_MAIN_EXECUTED callId=" + JSON.stringify(id));
              continue;
            }
            entry.done = true;
            accepted.push(r);
          }
          if (accepted.length > 0) {
            ctx.session?.sendToolResponse(accepted);
          } else if (all.length > 0) {
            console.log("[server] [tamper] ALL toolResponses dropped (fail-closed)");
          }
          return;
        }
        // Legacy path (standalone website, no Electron) — unchanged semantics.
        ctx.session?.sendToolResponse(msg.functionResponses);
      } else if (electronMode && smokeMode && msg.type === "smokeRegFail" && typeof msg.callId === "string") {
        // Smoke-only regression hook (Phase B.1): exercises the registration +
        // tracking path (including failure synthesis and duplicate handling)
        // without a live Gemini toolCall. Never active in normal runs.
        void registerAndTrackCall({ id: msg.callId, name: "getSystemTime", args: {} }).catch(() => {});
      }
    } catch (err) {
      console.error("[server] Error processing client message:", err);
    }
  });

  // Clean up when the client disconnects.
  ws.on("close", () => {
    console.log("[server] Client disconnected. Closing AI session...");
    sessions.delete(sessionId);
    ctx.session?.close();
    ctx.session = null;
  });
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

/**
 * T5R Phase B: verify an HMAC-verified completion against THIS server's own
 * registration state and, when valid, forward the result to Gemini.
 *
 * Verification sequence (fail-closed, each step logs a tamper marker):
 *   1. HMAC            — verified in handoff.ts before this is called
 *   2. sessionId route — receipt must name a live connection
 *   3. registry        — callId must be registered on that connection
 *   4. binding         — toolName + argsDigest must match the registration
 *   5. deadline        — server-side monotonic expiry (authoritative)
 *   6. terminal/nonce  — single-use, replay-rejected
 *   7. digest          — resultDigest must hash the carried result
 */
function handleCompletion(receipt: CompletionReceipt, sessions: Map<string, ConnectionContext>, consumedNonces: Set<string>): void {
  // Structural gate before anything else (B.3: protocol version pinned).
  if (
    receipt?.kind !== "completion" ||
    receipt.v !== 1 ||
    typeof receipt.callId !== "string" ||
    typeof receipt.toolName !== "string" ||
    typeof receipt.sessionId !== "string" ||
    typeof receipt.argsDigest !== "string" ||
    (receipt.executionStatus !== "success" &&
      receipt.executionStatus !== "execution_error" &&
      receipt.executionStatus !== "denied" &&
      receipt.executionStatus !== "cancelled")
  ) {
    console.log("[server] [tamper] COMPLETION_MALFORMED");
    return;
  }

  const ctx = sessions.get(receipt.sessionId);
  if (!ctx) {
    console.log("[server] [tamper] COMPLETION_UNKNOWN_SESSION callId=" + JSON.stringify(receipt.callId));
    return;
  }
  const entry = ctx.pending.get(receipt.callId);
  if (!entry) {
    console.log("[server] [tamper] COMPLETION_UNREGISTERED callId=" + JSON.stringify(receipt.callId));
    return;
  }
  if (
    entry.name !== receipt.toolName ||
    entry.argsDigest === null ||
    !timingSafeEq(entry.argsDigest, receipt.argsDigest)
  ) {
    console.log("[server] [tamper] COMPLETION_BINDING_MISMATCH callId=" + JSON.stringify(receipt.callId));
    return;
  }
  // Server-side monotonic deadline is authoritative.
  if (process.hrtime.bigint() > entry.deadlineNs) {
    ctx.pending.delete(receipt.callId);
    console.log("[server] [tamper] COMPLETION_EXPIRED callId=" + JSON.stringify(receipt.callId));
    return;
  }
  // Terminal state: any completion (valid or not) closes the registration.
  if (entry.done) {
    console.log("[server] [tamper] COMPLETION_TERMINAL callId=" + JSON.stringify(receipt.callId));
    return;
  }
  // Replay cache (defense-in-depth beneath the terminal-state check).
  if (consumedNonces.has(receipt.nonce)) {
    entry.done = true;
    console.log("[server] [tamper] COMPLETION_TERMINAL callId=" + JSON.stringify(receipt.callId) + " (nonce replay)");
    return;
  }
  if (!MAIN_EXECUTED_TOOLS.has(entry.name)) {
    // Completions only exist for main-executed tools.
    console.log("[server] [tamper] COMPLETION_NOT_MAIN_EXECUTED callId=" + JSON.stringify(receipt.callId));
    return;
  }

  // Result integrity: the signed digest must match the carried result.
  if (receipt.executionStatus === "success" || receipt.executionStatus === "execution_error") {
    if (typeof receipt.resultDigest !== "string" || !/^[0-9a-f]{64}$/.test(receipt.resultDigest)) {
      console.log("[server] [tamper] COMPLETION_DIGEST_MISMATCH callId=" + JSON.stringify(receipt.callId));
      return;
    }
    const canonical = strictCanonicalJson(receipt.result);
    if (canonical === null || sha256Hex(canonical) !== receipt.resultDigest) {
      console.log("[server] [tamper] COMPLETION_DIGEST_MISMATCH callId=" + JSON.stringify(receipt.callId));
      return;
    }
  }

  // Commit: terminal state is RETAINED (not deleted) so replays report
  // COMPLETION_TERMINAL; the entry self-expires at its deadline via the sweep.
  entry.done = true;
  consumedNonces.add(receipt.nonce);
  if (consumedNonces.size > NONCE_CACHE_MAX) {
    // Bounded FIFO eviction.
    const first = consumedNonces.values().next().value;
    if (first !== undefined) consumedNonces.delete(first);
  }

  const output =
    receipt.executionStatus === "success"
      ? receipt.result
      : { error: "toolExecutionFailed", detail: receipt.reason ?? receipt.executionStatus };
  try {
    ctx.session?.sendToolResponse([{ id: receipt.callId, name: receipt.toolName, response: { output } }]);
    console.log(
      "[server] Completion accepted callId=" + JSON.stringify(receipt.callId) + " status=" + receipt.executionStatus
    );
  } catch (err: any) {
    console.error("[server] Failed to forward completion to Gemini:", err?.message ?? err);
    return;
  }
  console.log("[smoke] COMPLETION_ACCEPTED");
}

/** Metadata-only execution status relay (e.g. state:"executing") to the renderer. */
function handleExecStatus(frame: { callId: string; sessionId: string; state: string }, sessions: Map<string, ConnectionContext>): void {
  if (frame.state !== "executing") return; // metadata-only allowlist
  const ctx = sessions.get(frame.sessionId);
  if (!ctx) return;
  try {
    sendJSON(ctx.ws, { type: "toolStatus", callId: frame.callId, state: frame.state });
  } catch {
    /* socket gone */
  }
}

export async function startServer(provider: AIProvider, config: ServerConfig): Promise<void> {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  // T5R Phase B: live connections by sessionId (completion routing) and a
  // bounded replay cache of consumed completion nonces.
  const sessions = new Map<string, ConnectionContext>();
  const consumedNonces = new Set<string>();

  // T5.0/T5R: Handoff client (Electron mode only). Standalone website runs get
  // exactly the legacy behaviour: no handoff, no ticket fields, no filtering.
  let handoff: ToolHandoff | null = null;
  if (config.electronMode && config.handoffPipe && config.handoffNonce && config.receiptKey) {
    handoff = createHandoffClient({
      pipeName: config.handoffPipe,
      nonce: config.handoffNonce,
      receiptKey: config.receiptKey,
      onCompletion: (receipt) => handleCompletion(receipt, sessions, consumedNonces),
      onExecStatus: (frame) => handleExecStatus(frame, sessions),
    });
    // Warm the pipe connection (non-fatal on failure). The warmup ticket is
    // discarded; its unused registration self-expires inside the authority.
    void handoff
      .registerPendingCall("__warmup__", "getSystemTime", {}, "__warmup__")
      .then((r) => {
        if (r.outcome === "ok") {
          console.log("[server] Handoff pipe connected; desktop tool routing enabled");
        }
      })
      .catch(() => {});
  }

  // Health endpoint — exposes provider name but NOT the API key, NOT the token.
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: config.nodeEnv,
      provider: provider.name,
      wsAuth: config.electronMode ? "token" : config.websiteMode,
    });
  });

  // Bridge each WebSocket client to the AI provider.
  wss.on("connection", (ws, req) => {
    // T5.0: authenticated local sessions. In Electron runs the desktop server
    // REQUIREs the per-run token; unauthenticated connections are rejected
    // before any AI session or tool path can begin.
    const authRequired = config.electronMode || config.websiteMode === "token";
    if (authRequired) {
      let supplied = "";
      try {
        const url = new URL(req.url ?? "", "http://127.0.0.1");
        supplied = url.searchParams.get("auth") ?? "";
      } catch {
        supplied = "";
      }
      const valid =
        typeof supplied === "string" &&
        supplied.length > 0 &&
        !!config.wsAuthToken &&
        timingSafeEq(supplied, config.wsAuthToken);
      if (!valid) {
        console.log("[server] [auth] REJECTED WebSocket connection (missing or invalid token)");
        sendJSON(ws, { type: "status", state: "error", message: "Authentication failed." });
        ws.close();
        return;
      }
    }
    handleConnection(ws, provider, handoff, sessions, config.electronMode === true, config.smokeMode === true);
  });

  // Vite dev middleware or static file serving for production.
  if (config.nodeEnv !== "production") {
    console.log("[server] Starting development server with Vite middleware...");
    // Lazy import so the production/packaged Electron build never loads Vite.
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("[server] Starting production server...");
    // Electron packaged build: MYRA_DIST_DIR points at the asar-unpacked dist
    // directory (real files on disk). Unset -> original behaviour unchanged.
    const distPath = process.env.MYRA_DIST_DIR
      ? path.resolve(process.env.MYRA_DIST_DIR)
      : path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(config.port, config.host, () => {
    console.log(`[server] Myraa AI server listening on http://${config.host}:${config.port}`);
    console.log(`[server] Provider: ${provider.name}`);
  });
}
