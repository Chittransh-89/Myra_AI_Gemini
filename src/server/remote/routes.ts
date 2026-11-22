/**
 * Myra AI — Phase 1 remote HTTP + WebSocket surface.
 *
 * Mounted on the existing Myra HTTP server (so the same process owns pairing,
 * status and — later — the Gemini session). The remote dashboard is served at
 * /remote; the authenticated phone socket is /remote/ws.
 *
 * Phase 1 is deliberately status-only:
 *   - no phone audio is accepted yet (Phase 2),
 *   - no ON/OFF control is accepted yet (Phase 3).
 * Unsupported frames receive an explicit "notImplemented" error instead of
 * being silently ignored.
 */

import express, { type NextFunction, type Request, type Response, type Router } from "express";
import fs from "fs";
import path from "path";
import { isIP } from "node:net";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";

import { timingSafeEq } from "../handoff.js";
import type { PairingManager } from "./pairing.js";
import type { RemoteRuntime } from "./runtime.js";
import type { RemoteAudioBridge } from "./audioBridge.js";

export const REMOTE_COOKIE_NAME = "myra_remote";
const MAX_WS_MESSAGE_BYTES = 64 * 1024;

/** Maximum decoded bytes for one phone audio chunk (100 ms PCM16 ≈ 3.2 KB). */
export const MAX_REMOTE_AUDIO_CHUNK_BYTES = 8 * 1024;
/** Guard before decoding base64 (4/3 expansion plus padding). */
const MAX_REMOTE_AUDIO_BASE64_CHARS = Math.ceil(MAX_REMOTE_AUDIO_CHUNK_BYTES / 3) * 4 + 4;
const BASE64_RX = /^[A-Za-z0-9+/]*={0,2}$/;
/** Do not spam a phone that keeps sending while no Gemini session exists. */
const AUDIO_ERROR_THROTTLE_MS = 2_000;
/** Mark streaming false when accepted audio stops arriving. */
const AUDIO_IDLE_MS = 2_000;

export interface RemoteRouterOptions {
  runtime: RemoteRuntime;
  pairing: PairingManager;
  /** The per-run desktop WS token. Never sent to the phone. */
  desktopToken: string;
  publicUrl: string | null;
  projectRoot: string;
  distDir: string;
  isProduction: boolean;
  /**
   * Trust one loopback reverse proxy (Tailscale Serve) for the client address
   * used by pairing rate limiting. Off by default: X-Forwarded-For is ignored.
   */
  trustProxy?: boolean;
  /**
   * Development only: Vite's index.html transform for /remote.
   *
   * Serving remote.html with res.sendFile bypasses Vite, so the React plugin's
   * refresh preamble is never injected and the entry module throws
   * "@vitejs/plugin-react can't detect preamble" — leaving #root empty (a white
   * screen). Running the HTML through this hook restores the normal dev
   * pipeline. Production builds are already transformed at build time.
   */
  transformHtml?: (html: string) => Promise<string>;
}

export interface RemoteWebSocketOptions {
  runtime: RemoteRuntime;
  pairing: PairingManager;
  publicUrl: string | null;
  /**
   * Phase 2 audio sink. When absent (or when no desktop /ws session is
   * attached) audio frames are rejected with `sessionUnavailable`; the remote
   * side never creates its own provider session.
   */
  audioBridge?: RemoteAudioBridge | null;
}

export interface RemoteWebSocketServer {
  /**
   * Returns true when this request targeted /remote/ws (handled or rejected),
   * false when the path belongs to another WebSocket server.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
}

function normalizeRemoteUrl(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    if (!url.pathname || url.pathname === "/") url.pathname = "/remote";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function readCookie(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function bearerToken(req: Request): string {
  const header = req.headers.authorization;
  if (typeof header !== "string") return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : "";
}

function phoneToken(req: Request): string {
  return readCookie(req.headers.cookie, REMOTE_COOKIE_NAME) || bearerToken(req);
}

function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers["x-forwarded-proto"];
  return (
    req.secure ||
    forwarded === "https" ||
    process.env.MYRA_REMOTE_FORCE_SECURE === "1"
  );
}

function requestOriginHost(req: Request): string {
  try {
    return new URL(`http://${req.headers.host ?? "127.0.0.1"}`).hostname;
  } catch {
    return "127.0.0.1";
  }
}

/** Strip ports/brackets/mapped IPv4 prefixes so addresses compare cleanly. */
function normalizeIp(raw: string | undefined | null): string {
  if (!raw) return "";
  let value = raw.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end > 0) value = value.slice(1, end);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(":"));
  }
  if (value.startsWith("::ffff:")) value = value.slice(7);
  return value;
}

function isLoopbackIp(value: string): boolean {
  return value === "::1" || value === "127.0.0.1" || value.startsWith("127.");
}

/**
 * Resolve the rate-limit identity for a pairing attempt.
 *
 * The direct socket peer is authoritative. `X-Forwarded-For` is consulted only
 * when the operator enabled `trustProxy` AND the peer is loopback (Myra reached
 * through Tailscale Serve). The right-most valid entry is the address the
 * trusted proxy itself observed, so a client cannot prepend a fake address to
 * escape its bucket; malformed headers fall back to the peer.
 */
function resolveClientKey(req: Request, trustProxy: boolean): string {
  const peer = normalizeIp(req.socket.remoteAddress);
  if (!trustProxy || !isLoopbackIp(peer)) return peer || "unknown";

  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return peer || "unknown";

  const entries = raw
    .split(",")
    .map(normalizeIp)
    .filter((entry) => entry.length > 0 && isIP(entry) !== 0);
  if (entries.length === 0) return peer || "unknown";
  return entries[entries.length - 1];
}

function isAllowedOrigin(origin: string | undefined, reqHost: string, publicUrl: string | null): boolean {
  // Non-browser clients (tests, curl) may omit Origin.
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (originHost === reqHost) return true;
  if (publicUrl) {
    try {
      if (originHost === new URL(publicUrl).hostname) return true;
    } catch {
      /* ignore malformed public URL */
    }
  }
  // Local development only.
  return originHost === "127.0.0.1" || originHost === "localhost";
}

function securityHeaders(isProduction: boolean) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "microphone=(self)");
    if (isProduction) res.setHeader("Content-Security-Policy", csp);
    next();
  };
}

/**
 * Last-resort HTML so a failed render is never a blank white page on the
 * phone. Static, self-contained, no scripts.
 */
const BOOT_FALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>Myra Remote</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#020617;color:#e2e8f0;font-family:system-ui,sans-serif">
<div style="max-width:22rem;padding:1.5rem;text-align:center">
<p style="font-size:.75rem;letter-spacing:.2em;color:#22d3ee;text-transform:uppercase">Myra Remote</p>
<h1 style="font-size:1.1rem;margin:.75rem 0">The dashboard could not start</h1>
<p style="font-size:.8rem;color:#94a3b8;line-height:1.6">The Myra PC is running but the remote page failed to load. Make sure the desktop app is fully started, then reload this page.</p>
<p><a href="/remote" style="display:inline-block;margin-top:1rem;padding:.6rem 1rem;border-radius:.75rem;border:1px solid #22d3ee66;color:#a5f3fc;text-decoration:none;font-size:.8rem">Reload</a></p>
</div></body></html>`;

function sendJSON(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function writeHttpError(socket: Duplex, status: number, error: string): void {
  const body = JSON.stringify({ ok: false, error });
  const reason =
    status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 409 ? "Conflict" : "Bad Request";
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "\r\n" +
        body
    );
  } catch {
    /* socket already gone */
  }
  try {
    socket.destroy();
  } catch {
    /* ignore */
  }
}

interface DecodedAudioFrame {
  ok: boolean;
  data?: string;
  bytes?: number;
  code?: "badAudio" | "audioTooLarge";
  message?: string;
}

/**
 * Validate an inbound phone audio frame before it reaches Gemini.
 * Base64 is checked strictly (no whitespace/URL-safe variants) and the decoded
 * payload must be a non-empty even-length PCM16 buffer within the chunk cap.
 */
function decodeAudioFrame(message: any): DecodedAudioFrame {
  const data = message?.data;
  if (typeof data !== "string" || data.length === 0) {
    return { ok: false, code: "badAudio", message: "Audio data must be a base64 string." };
  }
  if (data.length > MAX_REMOTE_AUDIO_BASE64_CHARS) {
    return { ok: false, code: "audioTooLarge", message: "Audio chunk exceeds the size limit." };
  }
  if (data.length % 4 !== 0 || !BASE64_RX.test(data)) {
    return { ok: false, code: "badAudio", message: "Audio data must be valid base64." };
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0) {
    return { ok: false, code: "badAudio", message: "Audio chunk is empty." };
  }
  if (bytes.length > MAX_REMOTE_AUDIO_CHUNK_BYTES) {
    return { ok: false, code: "audioTooLarge", message: "Audio chunk exceeds the size limit." };
  }
  if (bytes.length % 2 !== 0) {
    return { ok: false, code: "badAudio", message: "Audio must be PCM16 little-endian." };
  }
  return { ok: true, data, bytes: bytes.length };
}

/**
 * Create the Express router for the remote dashboard, pairing endpoints and
 * status snapshot. Mount BEFORE Vite/static middleware.
 */
export function createRemoteRouter(options: RemoteRouterOptions): Router {
  const {
    runtime,
    pairing,
    desktopToken,
    publicUrl,
    projectRoot,
    distDir,
    isProduction,
    trustProxy = false,
    transformHtml,
  } = options;
  const router = express.Router();
  const dashboardUrl = normalizeRemoteUrl(publicUrl);

  router.use("/remote", securityHeaders(isProduction));

  router.get("/remote", (_req, res) => {
    void sendDashboard(res);
  });
  router.get("/remote/", (_req, res) => {
    void sendDashboard(res);
  });

  async function sendDashboard(res: Response): Promise<void> {
    const file = isProduction
      ? path.join(distDir, "remote.html")
      : path.join(projectRoot, "remote.html");
    try {
      const html = await fs.promises.readFile(file, "utf8");
      const body = transformHtml ? await transformHtml(html) : html;
      res.status(200).type("html").send(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[remote] Failed to render the dashboard:", message);
      if (!res.headersSent) {
        res.status(500).type("html").send(BOOT_FALLBACK_HTML);
      }
    }
  }

  function requireDesktop(req: Request, res: Response, next: NextFunction): void {
    const supplied =
      typeof req.headers["x-myra-desktop-token"] === "string"
        ? req.headers["x-myra-desktop-token"]
        : "";
    if (!desktopToken || !timingSafeEq(String(supplied), desktopToken)) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    // Pairing codes and URLs are per-session secrets: never let a browser or
    // intermediary cache them.
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    // Every authenticated desktop poll is also a PC presence heartbeat.
    runtime.touchDesktop();
    next();
  }

  function requirePhone(req: Request, res: Response, next: NextFunction): void {
    const token = phoneToken(req);
    const session = pairing.verify(token);
    if (!session) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    (req as Request & { remoteToken?: string }).remoteToken = token;
    next();
  }

  router.get("/remote/api/state", requirePhone, (_req, res) => {
    res.json({ ok: true, snapshot: runtime.snapshot() });
  });

  router.post(
    "/remote/pair",
    express.json({ limit: "8kb", strict: true }),
    (req, res) => {
      if (!req.is("application/json")) {
        res.status(415).json({ ok: false, error: "jsonRequired" });
        return;
      }
      if (!isAllowedOrigin(req.headers.origin, requestOriginHost(req), publicUrl)) {
        res.status(403).json({ ok: false, error: "originRejected" });
        return;
      }

      const body = (req.body ?? {}) as { code?: unknown; deviceName?: unknown };
      const result = pairing.pair({
        code: String(body.code ?? ""),
        deviceName: String(body.deviceName ?? ""),
        clientKey: resolveClientKey(req, trustProxy),
      });

      if (!result.ok) {
        const failure = result as {
          ok: false;
          reason: "invalidCode" | "expiredCode" | "rateLimited";
          retryAfterMs?: number;
        };
        const status = failure.reason === "rateLimited" ? 429 : 400;
        res.status(status).json({
          ok: false,
          error: failure.reason,
          ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
        });
        return;
      }

      res.cookie(REMOTE_COOKIE_NAME, result.token, {
        httpOnly: true,
        sameSite: "strict",
        secure: isSecureRequest(req),
        path: "/remote",
        maxAge: pairing.sessionTtlMs,
      });
      res.json({
        ok: true,
        deviceName: result.deviceName,
        expiresAt: result.expiresAt,
        snapshot: runtime.snapshot(),
      });
    }
  );

  router.post("/remote/unpair", requirePhone, (req, res) => {
    const token = (req as Request & { remoteToken?: string }).remoteToken ?? phoneToken(req);
    pairing.unpair(token);
    res.clearCookie(REMOTE_COOKIE_NAME, { path: "/remote" });
    res.json({ ok: true });
  });

  // Desktop-only: show the one-time code + the phone URL. Authenticated with
  // the same per-run token the renderer already uses for /ws.
  router.get("/api/remote/pairing", requireDesktop, (_req, res) => {
    const info = pairing.getInfo();
    res.json({
      ok: true,
      enabled: true,
      code: info.code,
      expiresAt: info.expiresAt,
      pairedDevice: info.pairedDevice,
      pairedAt: info.pairedAt,
      remoteUrl: dashboardUrl,
      serverTime: Date.now(),
    });
  });

  router.post("/api/remote/pairing/rotate", requireDesktop, (_req, res) => {
    const info = pairing.rotateCode();
    res.json({
      ok: true,
      enabled: true,
      code: info.code,
      expiresAt: info.expiresAt,
      pairedDevice: info.pairedDevice,
      pairedAt: info.pairedAt,
      remoteUrl: dashboardUrl,
      serverTime: Date.now(),
    });
  });

  // JSON body-parser errors must not leak Express HTML into the phone UI.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    res.status(400).json({ ok: false, error: "badRequest" });
  });

  return router;
}

/**
 * Create the authenticated /remote/ws WebSocket handler. The caller owns the
 * HTTP server's upgrade dispatch (see startServer in src/server/index.ts).
 */
export function createRemoteWebSocketServer(options: RemoteWebSocketOptions): RemoteWebSocketServer {
  const { runtime, pairing, publicUrl, audioBridge = null } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });
  const activeSockets = new Set<WebSocket>();
  const activeBySession = new Map<string, WebSocket>();

  const unsubscribeRuntime = runtime.subscribe((snapshot) => {
    for (const ws of activeSockets) {
      sendJSON(ws, { type: "remoteState", snapshot });
    }
  });

  const unsubscribePairing = pairing.subscribe(() => {
    for (const [sessionId, ws] of activeBySession) {
      if (!pairing.isSessionActive(sessionId)) {
        try {
          ws.close(4003, "sessionRevoked");
        } catch {
          /* already gone */
        }
      }
    }
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const live = ws as WebSocket & { isAlive?: boolean };
      if (live.isAlive === false) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      live.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 25_000);
  if (typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref();

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const session = (req as IncomingMessage & { myraPairingSession?: { id: string; deviceName: string } })
      .myraPairingSession;
    if (!session) {
      try {
        ws.close(1008, "unauthorized");
      } catch {
        /* ignore */
      }
      return;
    }

    const live = ws as WebSocket & { isAlive?: boolean };
    live.isAlive = true;
    ws.on("pong", () => {
      live.isAlive = true;
    });

    // Phase 2 streaming presence + throttling state for this socket.
    let phoneStreaming = false;
    let lastAudioAt = 0;
    let lastAudioErrorAt = 0;
    const markStreaming = (streaming: boolean) => {
      if (phoneStreaming === streaming) return;
      phoneStreaming = streaming;
      runtime.setPhoneStreaming(streaming);
    };
    const sendAudioError = (code: string, message: string) => {
      const now = Date.now();
      if (now - lastAudioErrorAt < AUDIO_ERROR_THROTTLE_MS) return;
      lastAudioErrorAt = now;
      sendJSON(ws, { type: "error", code, message });
    };
    const audioWatchdog = setInterval(() => {
      if (phoneStreaming && Date.now() - lastAudioAt > AUDIO_IDLE_MS) {
        markStreaming(false);
      }
    }, 1_000);
    if (typeof audioWatchdog === "object" && "unref" in audioWatchdog) audioWatchdog.unref();

    // One active phone socket. A reconnect replaces the previous socket
    // instead of creating a second logical session.
    const previous = activeBySession.get(session.id);
    if (previous && previous !== ws && previous.readyState === WebSocket.OPEN) {
      try {
        previous.close(4001, "replaced");
      } catch {
        /* ignore */
      }
    }

    activeSockets.add(ws);
    activeBySession.set(session.id, ws);
    runtime.setPhone({ id: session.id, deviceName: session.deviceName });
    runtime.setError(null);

    sendJSON(ws, { type: "remoteState", snapshot: runtime.snapshot() });

    ws.on("message", (raw) => {
      const size = Array.isArray(raw) ? raw.reduce((total, chunk) => total + chunk.length, 0) : raw.byteLength;
      if (size > MAX_WS_MESSAGE_BYTES) {
        try {
          ws.close(1009, "messageTooLarge");
        } catch {
          /* ignore */
        }
        return;
      }

      let message: any;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        sendJSON(ws, { type: "error", code: "badMessage", message: "Invalid JSON." });
        return;
      }

      if (!message || typeof message !== "object" || typeof message.type !== "string") {
        sendJSON(ws, { type: "error", code: "badMessage", message: "Missing message type." });
        return;
      }

      switch (message.type) {
        case "requestState":
          sendJSON(ws, { type: "remoteState", snapshot: runtime.snapshot() });
          break;

        case "ping":
          sendJSON(ws, {
            type: "pong",
            ts: typeof message.ts === "number" ? message.ts : null,
            serverTime: Date.now(),
          });
          break;

        case "control":
          sendJSON(ws, {
            type: "error",
            code: "notImplemented",
            message: "Myra ON/OFF control is not enabled in Phase 2.",
          });
          break;

        case "audio": {
          const decoded = decodeAudioFrame(message);
          if (!decoded.ok) {
            if (decoded.code === "audioTooLarge") {
              sendJSON(ws, { type: "error", code: decoded.code, message: decoded.message });
              try {
                ws.close(1009, "messageTooLarge");
              } catch {
                /* already closing */
              }
              break;
            }
            sendJSON(ws, { type: "error", code: decoded.code, message: decoded.message });
            break;
          }

          if (!audioBridge) {
            sendAudioError("sessionUnavailable", "Phone audio is not wired in this server mode.");
            break;
          }

          // While Myra is speaking, drop phone uplink. Otherwise an open phone
          // microphone hears the PC speakers and feeds Myra's own voice back
          // into Gemini, whose voice-activity detection interrupts her —
          // producing choppy, stuttering speech on the PC.
          if (runtime.isMyraSpeaking()) {
            markStreaming(false);
            break;
          }

          const result = audioBridge.push(decoded.data as string, decoded.bytes as number);
          if (!result.ok) {
            if (result.reason === "noSession") {
              sendAudioError(
                "sessionUnavailable",
                "No active Gemini session. Audio is not forwarded until Phase 3 starts the managed session."
              );
            } else if (result.reason === "rateLimited") {
              sendAudioError("audioRateLimited", "Audio is arriving faster than real time.");
            } else {
              sendAudioError("audioRejected", "Audio could not be forwarded to Gemini.");
            }
            break;
          }

          lastAudioAt = Date.now();
          markStreaming(true);
          sendJSON(ws, {
            type: "audioAck",
            seq: typeof message.seq === "number" && Number.isFinite(message.seq) ? message.seq : null,
            bytes: decoded.bytes,
          });
          break;
        }

        case "audioStop":
          markStreaming(false);
          break;

        // Explicit deny: the phone is an audio input, never a tool client.
        case "toolResponse":
        case "toolCall":
        case "tool":
          sendJSON(ws, {
            type: "error",
            code: "forbidden",
            message: "The phone cannot execute tools or submit tool responses.",
          });
          break;

        default:
          sendJSON(ws, { type: "error", code: "badMessage", message: "Unsupported message type." });
      }
    });

    ws.on("close", () => {
      clearInterval(audioWatchdog);
      markStreaming(false);
      activeSockets.delete(ws);
      if (activeBySession.get(session.id) === ws) {
        activeBySession.delete(session.id);
        runtime.clearPhone(session.id);
      }
    });

    ws.on("error", () => {
      /* close handler performs cleanup */
    });
  });

  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      let url: URL;
      try {
        url = new URL(req.url ?? "", "http://127.0.0.1");
      } catch {
        return false;
      }
      if (url.pathname !== "/remote/ws") return false;

      if (!isAllowedOrigin(req.headers.origin, requestOriginHostFromIncoming(req), publicUrl)) {
        writeHttpError(socket, 403, "originRejected");
        return true;
      }

      // Cookies only: never accept the phone token in the URL/query string.
      const token = readCookie(req.headers.cookie, REMOTE_COOKIE_NAME);
      const session = pairing.verify(token);
      if (!session) {
        writeHttpError(socket, 401, "unauthorized");
        return true;
      }

      // Carry the verified session to the connection handler without widening
      // the EventEmitter callback signature.
      (req as IncomingMessage & { myraPairingSession?: { id: string; deviceName: string } })
        .myraPairingSession = { id: session.id, deviceName: session.deviceName };

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return true;
    },

    close(): void {
      unsubscribeRuntime();
      unsubscribePairing();
      clearInterval(heartbeat);
      for (const ws of activeSockets) {
        try {
          ws.close(1001, "serverClosing");
        } catch {
          /* ignore */
        }
      }
      activeSockets.clear();
      activeBySession.clear();
      wss.close();
    },
  };
}

function requestOriginHostFromIncoming(req: IncomingMessage): string {
  try {
    return new URL(`http://${req.headers.host ?? "127.0.0.1"}`).hostname;
  } catch {
    return "127.0.0.1";
  }
}
