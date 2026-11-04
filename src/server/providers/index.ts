/**
 * ProviderFactory — selects and instantiates the correct AIProvider.
 *
 * Reads AI_PROVIDER from the already-loaded ServerConfig.
 * Never falls back silently between providers.
 * If the selected provider is unavailable, startup fails with a clear error.
 */

import type { ServerConfig } from "../config.js";
import type { AIProvider } from "./types.js";
import { GeminiProvider } from "./gemini.js";
import { LocalProvider } from "./local.js";

export async function createProvider(config: ServerConfig): Promise<AIProvider> {
  let provider: AIProvider;

  switch (config.aiProvider) {
    case "gemini": {
      if (!config.geminiApiKey) {
        throw new Error(
          "AI_PROVIDER=gemini requires GEMINI_API_KEY to be set in your environment. " +
            "Add it to your .env file and restart the server."
        );
      }
      provider = new GeminiProvider(config.geminiApiKey);
      break;
    }

    case "local": {
      provider = new LocalProvider();
      break;
    }

    default: {
      // TypeScript exhaustiveness guard — should never reach here.
      const unreachable: never = config.aiProvider;
      throw new Error(`Unknown AI provider: "${unreachable}"`);
    }
  }

  // Check availability but do NOT throw for local — it's a known non-functional stub.
  // The session creation itself will surface the error when a client connects.
  const available = await provider.isAvailable();
  if (!available && config.aiProvider !== "local") {
    throw new Error(
      `Provider "${provider.name}" reports itself as unavailable. ` +
        "Check your API keys and environment configuration."
    );
  }

  console.log(`[ProviderFactory] Using provider: ${provider.name}`);
  return provider;
}

export type { AIProvider } from "./types.js";
export type { AIProviderSession, AIProviderSessionConfig, AIProviderSessionCallbacks, FunctionCall, FunctionResponse, ToolDeclaration } from "./types.js";
