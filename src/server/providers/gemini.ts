/**
 * GeminiProvider — wraps Gemini Live API as an AIProvider.
 *
 * The logic here is extracted directly from the original server.ts with no
 * behavioural changes. The Gemini Live streaming session (audio in/out, tool
 * calls, VAD interrupts, turn management) is preserved exactly.
 *
 * API key stays exclusively here on the backend.
 * It is never forwarded to the frontend.
 */

import { GoogleGenAI, Modality, Type } from "@google/genai";
import type {
  AIProvider,
  AIProviderSession,
  AIProviderSessionCallbacks,
  AIProviderSessionConfig,
  ToolDeclaration,
  ToolParameterSchema,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Converts the provider-agnostic ToolDeclaration into the shape that
 * @google/genai expects. We do this conversion once per session rather than
 * coupling callers to the SDK types.
 */
function toGeminiTools(declarations: ToolDeclaration[]) {
  const functionDeclarations = declarations.map((decl) => {
    const fd: Record<string, unknown> = {
      name: decl.name,
      description: decl.description,
    };

    if (decl.parameters) {
      fd.parameters = convertParameters(decl.parameters);
    }

    return fd;
  });

  return [{ functionDeclarations }];
}

function convertProperty(val: any): Record<string, unknown> {
  const geminiType = mapType(val.type);
  const prop: Record<string, unknown> = { type: geminiType };
  if (val.description) prop.description = val.description;
  if (val.enum) prop.enum = val.enum;
  if (val.items) {
    prop.items = convertProperty(val.items);
  }
  if (val.properties) {
    const nested: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val.properties)) {
      nested[k] = convertProperty(v);
    }
    prop.properties = nested;
  }
  if (val.required) prop.required = val.required;
  return prop;
}

function convertParameters(schema: ToolParameterSchema): Record<string, unknown> {
  const props: Record<string, unknown> = {};

  if (schema.properties) {
    for (const [key, val] of Object.entries(schema.properties)) {
      props[key] = convertProperty(val);
    }
  }

  return {
    type: Type.OBJECT,
    properties: props,
    ...(schema.required ? { required: schema.required } : {}),
  };
}

function mapType(t: string): unknown {
  switch (t) {
    case "string":  return Type.STRING;
    case "number":  return Type.NUMBER;
    case "boolean": return Type.BOOLEAN;
    case "object":  return Type.OBJECT;
    case "array":   return Type.ARRAY;
    default:        return Type.STRING;
  }
}

/**
 * Security helper — produces a safe, truncated log string from arbitrary
 * error/event/unknown values.
 *
 * Why this exists: the Gemini Live WebSocket URL contains the API key as a
 * query parameter (e.g. wss://...?key=...). Serialising raw CloseEvent /
 * ErrorEvent objects used to print that URL (and therefore the API key) into
 * the console. This helper stringifies, redacts any credential-bearing query
 * parameters, and truncates.
 */
function sanitizeLogText(raw: unknown): string {
  let text: string;

  if (raw === undefined || raw === null) {
    text = "";
  } else if (typeof raw === "string") {
    text = raw;
  } else if (raw instanceof Error) {
    text = raw.message;
  } else if (typeof raw === "object") {
    try {
      text = JSON.stringify(raw);
    } catch {
      text = Object.prototype.toString.call(raw);
    }
  } else {
    text = String(raw);
  }

  return text
    .replace(
      /([?&](?:key|api_key|apikey|api-key|access_token|token|password|secret)\s*=)[^&"',\s]+/gi,
      "$1[REDACTED]"
    )
    .slice(0, 300);
}

// ---------------------------------------------------------------------------
// GeminiSession — thin wrapper around a live.connect() session
// ---------------------------------------------------------------------------

class GeminiSession implements AIProviderSession {
  // The live session object from @google/genai
  // Typed as `any` because the SDK does not export the session class type.
  private session: any;

  constructor(session: any) {
    this.session = session;
  }

  sendAudio(base64PCM: string): void {
    if (!this.session) return;
    try {
      this.session.sendRealtimeInput({
        audio: {
          data: base64PCM,
          mimeType: "audio/pcm;rate=16000",
        },
      });
    } catch (err) {
      console.error("[GeminiSession] Error sending audio:", sanitizeLogText(err));
    }
  }

  sendToolResponse(responses: import("./types.js").FunctionResponse[]): void {
    if (!this.session) return;
    try {
      // Log tool names only — never serialise full tool payloads (they can
      // contain arbitrary user data).
      console.log(
        "[GeminiSession] Forwarding tool responses:",
        responses.map((r) => r.name).join(", ") || "(none)"
      );
      this.session.sendToolResponse({ functionResponses: responses });
    } catch (err) {
      console.error("[GeminiSession] Error sending tool response:", sanitizeLogText(err));
    }
  }

  close(): void {
    if (!this.session) return;
    try {
      this.session.close();
    } catch (err) {
      console.error("[GeminiSession] Error closing session:", sanitizeLogText(err));
    }
    this.session = null;
  }
}

// ---------------------------------------------------------------------------
// GeminiProvider
// ---------------------------------------------------------------------------

export class GeminiProvider implements AIProvider {
  readonly name = "gemini";

  private ai: GoogleGenAI;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          // Preserve the original User-Agent header from server.ts
          "User-Agent": "aistudio-build",
        },
      },
    });
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async createSession(
    config: AIProviderSessionConfig,
    callbacks: AIProviderSessionCallbacks
  ): Promise<AIProviderSession> {
    const geminiTools = toGeminiTools(config.tools);

    // Build Gemini Live connect config — mirrors server.ts exactly.
    const liveConfig: Record<string, unknown> = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: config.voiceConfig?.voiceName ?? "Kore",
          },
        },
      },
      systemInstruction: config.systemInstruction,
      tools: geminiTools,
    };

    // Establish the Gemini Live WebSocket session.
    const session = await this.ai.live.connect({
      model: "gemini-3.1-flash-live-preview",
      config: liveConfig as any,
      callbacks: {
        onmessage: (message: any) => {
          // Forward audio parts to the caller
          if (message.serverContent) {
            const { modelTurn, interrupted, turnComplete } = message.serverContent;

            if (modelTurn?.parts) {
              for (const part of modelTurn.parts) {
                if (part.inlineData?.data) {
                  callbacks.onAudio(part.inlineData.data);
                }
              }
            }

            if (interrupted) {
              console.log("[GeminiProvider] Model speech interrupted");
              callbacks.onInterrupted();
            }

            if (turnComplete) {
              callbacks.onTurnComplete();
            }
          }

          // Forward tool calls to the caller
          if (message.toolCall) {
            // Log tool names only — never serialise the full message payload.
            console.log(
              "[GeminiProvider] Tool calls requested:",
              Array.isArray(message.toolCall.functionCalls)
                ? message.toolCall.functionCalls.map((c: { name: string }) => c.name).join(", ")
                : "(unknown)"
            );
            callbacks.onToolCall(message.toolCall.functionCalls);
          }
        },

        onclose: (event: any) => {
          // SECURITY: never log the raw CloseEvent — its target WebSocket URL
          // contains the GEMINI_API_KEY as a query parameter. Log safe
          // connection metadata only (code / clean flag / sanitized reason).
          const code = typeof event?.code === "number" ? event.code : "unknown";
          const wasClean = typeof event?.wasClean === "boolean" ? event.wasClean : "unknown";
          console.log(
            `[GeminiProvider] Live connection closed (code: ${code}, clean: ${wasClean}, reason: ${
              sanitizeLogText(event?.reason) || "none"
            })`
          );
          callbacks.onClose("Gemini connection closed");
        },

        onerror: (err: any) => {
          // SECURITY: log a sanitized message instead of the raw error object
          // (error payloads may embed the authenticated request URL).
          const safeMessage =
            sanitizeLogText(err instanceof Error ? err.message : err) || "Unknown Gemini Live error";
          console.error("[GeminiProvider] Live connection error:", safeMessage);
          callbacks.onError(
            err instanceof Error ? err : new Error(safeMessage)
          );
        },
      },
    });

    console.log("[GeminiProvider] Live session established");
    return new GeminiSession(session);
  }
}
