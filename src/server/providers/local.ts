/**
 * LocalProvider — placeholder for future local AI (Ollama) integration.
 *
 * This provider is NOT functional and will NOT silently fall back to Gemini.
 * When AI_PROVIDER=local is configured, any session creation attempt is
 * immediately refused with a clear, explicit error sent to the client.
 *
 * DO NOT implement any real logic here until local inference is fully built
 * and tested. The honest stub prevents accidental cloud requests.
 */

import type {
  AIProvider,
  AIProviderSession,
  AIProviderSessionCallbacks,
  AIProviderSessionConfig,
} from "./types.js";

const NOT_IMPLEMENTED_MESSAGE =
  "Local AI is not yet implemented. " +
  "Set AI_PROVIDER=gemini in your .env file to use Gemini Live, " +
  "or wait for Phase 4 (Ollama integration) to be completed.";

export class LocalProvider implements AIProvider {
  readonly name = "local";

  async isAvailable(): Promise<boolean> {
    // Local AI is not available until actually implemented.
    return false;
  }

  async createSession(
    _config: AIProviderSessionConfig,
    _callbacks: AIProviderSessionCallbacks
  ): Promise<AIProviderSession> {
    // Reject explicitly — do NOT fall back to Gemini or any other provider.
    throw new Error(NOT_IMPLEMENTED_MESSAGE);
  }
}
