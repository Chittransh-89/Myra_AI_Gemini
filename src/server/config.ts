/**
 * Centralised environment configuration loader.
 *
 * All environment variables are read and validated here.
 * The rest of the server imports from this module — never from process.env directly.
 * This keeps API keys exclusively on the backend and makes the config surface explicit.
 */

import path from "path";

export type AIProviderName = "gemini" | "local";

export interface ServerConfig {
  /** Which AI provider to use. Defaults to "gemini". */
  aiProvider: AIProviderName;

  /** Gemini API key. Only present when aiProvider === "gemini". */
  geminiApiKey: string | undefined;

  /** HTTP/WS server port. Defaults to 3000. */
  port: number;

  /** Bind address. Defaults to 127.0.0.1 so the desktop app is not exposed to the LAN. */
  host: string;

  /** Node environment. */
  nodeEnv: string;

  // --- T5.0 trust stack (desktop Electron mode) ---

  /** True when booted by the Electron main process (dev child OR in-process). */
  electronMode: boolean;

  /** "token" -> unauthenticated WS rejected. "open" -> legacy website behaviour. */
  websiteMode: "token" | "open";

  /** Per-run WS client credential. Present only in electronMode. NEVER logged. */
  wsAuthToken: string | undefined;

  /** Named pipe provided by the Electron main Handoff Authority (electronMode). */
  handoffPipe: string | undefined;

  /** Per-run handshake nonce for the handoff pipe. NEVER logged. */
  handoffNonce: string | undefined;

  /** Per-run completion-receipt HMAC key (hex), shared main<->server via env. NEVER logged, never sent to the renderer. */
  receiptKey: string | undefined;

  /** Smoke-test mode (MYRA_SMOKE=1): enables the synthetic pending-call hook for the completion path. */
  smokeMode: boolean;

  // --- Phase 1 remote control (phone dashboard + pairing) ---

  /** True when the authenticated phone remote surface is enabled. */
  remoteEnabled: boolean;

  /** Optional public HTTPS URL of the remote dashboard (e.g. Tailscale Serve). */
  remotePublicUrl: string | null;

  /**
   * Trust exactly one loopback reverse proxy (Tailscale Serve) when resolving
   * the client address used for pairing rate limiting.
   *
   * Default false: `X-Forwarded-For` is ignored and the socket peer is used.
   * Enable only when Myra's loopback port is reached through a local proxy
   * that overwrites/appends that header.
   */
  trustProxy: boolean;

  // --- Project Intelligence + Interview Mode ---

  /** True unless MYRA_INTELLIGENCE=0 explicitly disables the feature. */
  intelligenceEnabled: boolean;

  /** Directory for analysed projects, interview sessions and reports (JSON). */
  intelligenceDataDir: string;

  /** Roots approved by the native folder picker (Electron main process writes it). */
  approvedProjectsFile: string | null;

  /** Gemini text model used for analysis and interview questions. */
  intelligenceModel: string;

  /** Max Gemini text requests per analysis run and per interview session. */
  intelligenceRequestCap: number;
}

function parseProviderName(raw: string | undefined): AIProviderName {
  if (raw === "local") return "local";
  // Default to gemini; reject unknown values with a clear warning.
  if (raw !== undefined && raw !== "gemini") {
    console.warn(
      `[config] Unknown AI_PROVIDER="${raw}". Accepted values: gemini, local. Defaulting to gemini.`
    );
  }
  return "gemini";
}

function parsePort(raw: string | undefined): number {
  const n = parseInt(raw ?? "3000", 10);
  return isNaN(n) ? 3000 : n;
}

function parseHost(raw: string | undefined): string {
  // Desktop-first default: loopback only. HOST=0.0.0.0 restores the old
  // LAN-exposed behaviour for anyone hosting the website version.
  return raw ?? "127.0.0.1";
}

function parseRequestCap(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 40;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.warn(
      `[config] MYRA_INTELLIGENCE_REQUEST_CAP="${raw}" is not a positive integer. ` +
        "Using the default of 40 requests per analysis/interview session."
    );
    return 40;
  }
  return value;
}

const FLAG_TRUE = new Set(["1", "true", "yes", "on"]);
const FLAG_FALSE = new Set(["0", "false", "no", "off"]);

/**
 * Strict boolean flag parsing for security-sensitive switches.
 *
 * Only explicit true/false tokens are accepted. Unknown values (typos such as
 * MYRA_REMOTE=ture, or a value meant for another tool) are rejected with a
 * warning and the safe fallback is used, so a mistake can never silently
 * enable remote access.
 */
function parseStrictFlag(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "") return fallback;
  if (FLAG_TRUE.has(value)) return true;
  if (FLAG_FALSE.has(value)) return false;
  console.warn(
    `[config] ${name}="${raw}" is not a recognised boolean ` +
      "(use 1/0, true/false, yes/no, on/off). " +
      `Falling back to the safe default: ${fallback ? "enabled" : "disabled"}.`
  );
  return fallback;
}

// --- T5.0 trust stack -------------------------------------------------------
// Electron main sets MYRA_ELECTRON=1 + per-run secrets in env for both server
// topologies (spawned dev child and in-process). Secrets are never printed.

export function loadConfig(): ServerConfig {
  const electronMode = process.env.MYRA_ELECTRON === "1";
  const websiteMode: "token" | "open" = electronMode
    ? "token"
    : process.env.MYRA_WEBSITE_MODE === "token"
    ? "token"
    : "open";

  // MYRA_REMOTE: unset means "enabled in Electron mode" (the Phase 1 default).
  // An explicit value must be a recognised boolean; an invalid value fails
  // closed instead of silently exposing the remote surface.
  const remoteRaw = process.env.MYRA_REMOTE;
  const remoteFlag =
    remoteRaw === undefined || remoteRaw.trim() === ""
      ? true
      : parseStrictFlag(remoteRaw, false, "MYRA_REMOTE");
  const trustProxy = parseStrictFlag(process.env.MYRA_TRUST_PROXY, false, "MYRA_TRUST_PROXY");

  const config: ServerConfig = {
    aiProvider: parseProviderName(process.env.AI_PROVIDER),
    geminiApiKey: process.env.GEMINI_API_KEY,
    port: parsePort(process.env.PORT),
    host: parseHost(process.env.HOST),
    nodeEnv: process.env.NODE_ENV ?? "development",
    electronMode,
    websiteMode,
    wsAuthToken: electronMode ? process.env.MYRA_WS_TOKEN : undefined,
    handoffPipe: electronMode ? process.env.MYRA_HANDOFF_PIPE : undefined,
    handoffNonce: electronMode ? process.env.MYRA_HANDOFF_NONCE : undefined,
    receiptKey: electronMode ? process.env.MYRA_RECEIPT_KEY : undefined,
    smokeMode: process.env.MYRA_SMOKE === "1",
    // Remote control is a desktop (Electron) feature. MYRA_REMOTE=0 disables it
    // explicitly; standalone website runs keep the legacy behaviour.
    remoteEnabled: electronMode && remoteFlag,
    remotePublicUrl: process.env.MYRA_REMOTE_PUBLIC_URL?.trim() || null,
    trustProxy,
    intelligenceEnabled: parseStrictFlag(process.env.MYRA_INTELLIGENCE, true, "MYRA_INTELLIGENCE"),
    intelligenceDataDir:
      process.env.MYRA_DATA_DIR?.trim() || path.join(process.cwd(), ".myra-data"),
    approvedProjectsFile: process.env.MYRA_APPROVED_PROJECTS_FILE?.trim() || null,
    intelligenceModel: process.env.MYRA_INTELLIGENCE_MODEL?.trim() || "gemini-3.8-flash",
    intelligenceRequestCap: parseRequestCap(process.env.MYRA_INTELLIGENCE_REQUEST_CAP),
  };

  if (websiteMode === "open" || websiteMode === "token") {
    if (!electronMode && websiteMode === "open") {
      console.log(
        "[config] Standalone website mode (no Electron): WS auth disabled by policy — " +
          "desktop tool handoff is permanently unavailable in this mode."
      );
    }
  }

  // Warn early so the developer sees the issue before the first WebSocket connection.
  if (config.aiProvider === "gemini" && !config.geminiApiKey) {
    console.warn(
      "[config] WARNING: AI_PROVIDER=gemini but GEMINI_API_KEY is not set. " +
        "Real-time Gemini Live sessions will fail until the key is provided."
    );
  }

  if (config.aiProvider === "local") {
    console.warn(
      "[config] AI_PROVIDER=local selected. " +
        "Local AI is not yet implemented. Sessions will be refused with an explicit error."
    );
  }

  console.log(
    `[config] AI provider: ${config.aiProvider} | Port: ${config.port} | Env: ${config.nodeEnv}` +
      ` | Remote: ${config.remoteEnabled ? "on" : "off"} | TrustProxy: ${config.trustProxy ? "on" : "off"}` +
      ` | Intelligence: ${config.intelligenceEnabled ? "on" : "off"}`
  );

  return config;
}
