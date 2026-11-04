/**
 * AI Provider abstraction types.
 *
 * These interfaces decouple the WebSocket server from any specific AI backend.
 * The shapes are derived directly from the existing Gemini Live integration so
 * that GeminiProvider can implement them without any behavioural change.
 *
 * IMPORTANT: The session model is streaming/bidirectional, NOT request-response.
 * Gemini Live (and any future real-time provider) requires this design.
 */

// ---------------------------------------------------------------------------
// Tool declaration shapes (mirror @google/genai but kept provider-agnostic)
// ---------------------------------------------------------------------------

export type PropertyType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array";

export interface ToolPropertySchema {
  type: PropertyType;
  description?: string;
  enum?: string[];
  items?: ToolPropertySchema;
  properties?: Record<string, ToolPropertySchema>;
  required?: string[];
}

export interface ToolParameterSchema {
  type: "object";
  properties?: Record<string, ToolPropertySchema>;
  required?: string[];
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters?: ToolParameterSchema;
}

// ---------------------------------------------------------------------------
// Function call / response shapes (what the provider sends back to WS server)
// ---------------------------------------------------------------------------

/** A single function call requested by the AI model. */
export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

/** A single function response to send back to the AI model. */
export interface FunctionResponse {
  name: string;
  response: { output: unknown };
  id: string;
}

// ---------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------

export interface VoiceConfig {
  voiceName: string;
}

export interface AIProviderSessionConfig {
  systemInstruction: string;
  tools: ToolDeclaration[];
  voiceConfig?: VoiceConfig;
}

// ---------------------------------------------------------------------------
// Session callbacks (server → provider, events fired by the AI backend)
// ---------------------------------------------------------------------------

export interface AIProviderSessionCallbacks {
  /** Called with each base64-encoded PCM audio chunk from the AI. */
  onAudio: (base64PCMData: string) => void;

  /** Called when the model wants to invoke client-side tools. */
  onToolCall: (functionCalls: FunctionCall[]) => void;

  /** Called when the model's speech was interrupted (VAD detected user speech). */
  onInterrupted: () => void;

  /** Called when a full conversational turn is complete. */
  onTurnComplete: () => void;

  /** Called on a non-fatal or fatal provider error. */
  onError: (error: Error) => void;

  /** Called when the provider connection closes (cleanly or otherwise). */
  onClose: (reason?: string) => void;
}

// ---------------------------------------------------------------------------
// Session handle returned by createSession()
// ---------------------------------------------------------------------------

export interface AIProviderSession {
  /**
   * Send a chunk of microphone audio to the AI.
   * @param base64PCM Base64-encoded raw 16kHz PCM audio.
   */
  sendAudio(base64PCM: string): void;

  /**
   * Send tool execution results back to the AI model.
   */
  sendToolResponse(responses: FunctionResponse[]): void;

  /**
   * Gracefully terminate the session.
   */
  close(): void;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface AIProvider {
  /** Human-readable provider name for logging. */
  readonly name: string;

  /**
   * Returns true if this provider is configured and reachable.
   * Should NOT throw — return false on any error.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Opens a new streaming AI session.
   * Resolves once the session is ready to receive audio.
   * Rejects if the session cannot be established.
   */
  createSession(
    config: AIProviderSessionConfig,
    callbacks: AIProviderSessionCallbacks
  ): Promise<AIProviderSession>;
}
