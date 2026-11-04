/**
 * Centralised environment configuration loader.
 *
 * All environment variables are read and validated here.
 * The rest of the server imports from this module — never from process.env directly.
 * This keeps API keys exclusively on the backend and makes the config surface explicit.
 */

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

export function loadConfig(): ServerConfig {
  const config: ServerConfig = {
    aiProvider: parseProviderName(process.env.AI_PROVIDER),
    geminiApiKey: process.env.GEMINI_API_KEY,
    port: parsePort(process.env.PORT),
    host: parseHost(process.env.HOST),
    nodeEnv: process.env.NODE_ENV ?? "development",
  };

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

  console.log(`[config] AI provider: ${config.aiProvider} | Port: ${config.port} | Env: ${config.nodeEnv}`);

  return config;
}
