/**
 * Myra AI — text-generation adapter for Project Intelligence.
 *
 * This is NOT a second AI provider: it is a one-shot text helper that uses the
 * SAME Gemini API key and the same @google/genai SDK as the existing Live
 * provider. The realtime voice pipeline is untouched.
 *
 * Keeping it behind a tiny interface lets the interview engine be tested with a
 * deterministic fake model.
 */

import { GoogleGenAI } from "@google/genai";

import { IntelligenceError } from "./types.js";
import type { GeminiUsageTracker } from "../geminiUsage.js";

export interface TextModelRequest {
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Short, stable feature label recorded by the local usage counter. */
  feature?: string;
}

export interface TextModel {
  readonly name: string;
  generateJSON(request: TextModelRequest): Promise<unknown>;
}

const GENERATION_TIMEOUT_MS = 90_000;

/** Default Gemini request allowance for one analysis run or interview session. */
export const DEFAULT_SESSION_REQUEST_CAP = 40;

/**
 * True when the SDK/provider error means the API key has no quota left.
 * Gemini surfaces this as HTTP 429 or RESOURCE_EXHAUSTED, depending on whether
 * the error comes from the REST layer or the SDK's own error wrapper.
 */
export function isGeminiQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const value = err as any;
  const statuses = [
    value.status,
    value.code,
    value.response?.status,
    value.error?.code,
    value.error?.status,
    value.cause?.status,
  ];
  if (statuses.some((status) => Number(status) === 429)) return true;

  const message = [value.message, value.error?.message, value.cause?.message]
    .filter((part) => typeof part === "string")
    .join(" ");
  return /RESOURCE_EXHAUSTED|quota|rate limit|too many requests|\b429\b/i.test(message);
}

/**
 * Per-session Gemini request allowance. Callers consume before every model
 * request (including retries/splits), so a cap bounds the whole session rather
 * than a single call.
 */
export class RequestBudget {
  private used = 0;

  constructor(
    readonly limit: number,
    readonly label = "This session"
  ) {}

  get usedCount(): number {
    return this.used;
  }

  consume(): void {
    if (this.used >= this.limit) {
      throw new IntelligenceError(
        "requestCapReached",
        `${this.label} reached its Gemini request limit (${this.limit}). Retry later or raise MYRA_INTELLIGENCE_REQUEST_CAP in the Myra .env file.`,
        429
      );
    }
    this.used += 1;
  }
}

/** Everything a JSON parse failure needs to explain itself honestly. */
export interface JsonParseContext {
  finishReason?: string;
}

function stripFences(raw: string): string {
  let text = String(raw ?? "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  return text;
}

function jsonStart(text: string): number {
  const object = text.indexOf("{");
  const array = text.indexOf("[");
  if (object === -1) return array;
  if (array === -1) return object;
  return Math.min(object, array);
}

/** Index of the matching close bracket, or -1 when the document is truncated. */
function balancedEnd(text: string, start: number): number {
  const stack: string[] = [text[start] === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      stack.push("}");
    } else if (ch === "[") {
      stack.push("]");
    } else if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] !== ch) return -1;
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Best-effort repair for a response cut off by the output-token limit.
 * It only ever closes containers that were really opened, so the result is a
 * valid (if incomplete) object; every field is still validated by the caller.
 */
function repairTruncatedJson(text: string): unknown | null {
  let cut = text.trim();
  const start = jsonStart(cut);
  if (start < 0) return null;
  cut = cut.slice(start);

  // Step back one member at a time. This removes a dangling `"key":` or a
  // half-written string/value instead of guessing content.
  for (let attempt = 0; attempt < 80; attempt++) {
    let candidate = cut.replace(/[\s,]+$/, "");

    // Still inside a string? Drop the unfinished string and its key.
    let inString = false;
    let escaped = false;
    for (const ch of candidate) {
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      }
    }
    if (inString) {
      const lastQuote = candidate.lastIndexOf('"');
      candidate = lastQuote > 0 ? candidate.slice(0, lastQuote) : "";
      candidate = candidate.replace(/[,:]\s*$/, "").replace(/,?\s*"[^"]*"\s*:?\s*$/, "");
      candidate = candidate.replace(/[\s,]+$/, "");
    }

    // Drop a trailing incomplete key or `key:`. A value is mandatory in JSON.
    candidate = candidate
      .replace(/,\s*"[^"]*"\s*:\s*$/, "")
      .replace(/"[^"]*"\s*:\s*$/, "")
      .replace(/[\s,]+$/, "");

    // Close whatever is genuinely open.
    const stack: string[] = [];
    let str = false;
    let esc = false;
    let mismatch = false;
    for (const ch of candidate) {
      if (str) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') str = false;
        continue;
      }
      if (ch === '"') str = true;
      else if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") {
        if (stack[stack.length - 1] !== ch) {
          mismatch = true;
          break;
        }
        stack.pop();
      }
    }

    if (!mismatch && !str) {
      const closed = candidate + stack.reverse().join("");
      try {
        return JSON.parse(closed);
      } catch {
        /* try a shorter cut */
      }
    }

    const comma = cut.lastIndexOf(",");
    if (comma < 0) return null;
    cut = cut.slice(0, comma);
  }
  return null;
}

/** Parse the first JSON object/array in a model response. */
export function extractJson(raw: string, context: JsonParseContext = {}): unknown {
  const text = stripFences(raw);
  const reason = context.finishReason ? `finish reason: ${context.finishReason}` : "no finish reason";

  if (!text) {
    throw new IntelligenceError(
      "emptyModelResponse",
      `The AI returned an empty response (${reason}).`,
      502
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    // Fall through to structural extraction.
  }

  const start = jsonStart(text);
  if (start < 0) {
    throw new IntelligenceError(
      "invalidModelJson",
      `The AI response contained no JSON object (${text.length} chars, ${reason}).`,
      502
    );
  }

  // 1. A complete document plus trailing prose (or a fence edge case).
  const end = balancedEnd(text, start);
  if (end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }

  // 2. Truncated output: close only the containers the model really opened,
  //    stepping back member by member. Callers validate every field, so a
  //    partial record can never fabricate project facts.
  const repaired = repairTruncatedJson(text);
  if (repaired !== null) return repaired;

  const tail = text.slice(-60).replace(/\s+/g, " ");
  throw new IntelligenceError(
    "invalidModelJson",
    `The AI response could not be parsed as JSON (${text.length} chars, ${reason}; ends with "${tail}").`,
    502
  );
}

export class GeminiTextModel implements TextModel {
  readonly name: string;
  private ai: GoogleGenAI;
  private model: string;

  constructor(
    apiKey: string,
    model = "gemini-3.8-flash",
    private usage?: GeminiUsageTracker
  ) {
    this.name = model;
    this.model = model;
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generateJSON(request: TextModelRequest): Promise<unknown> {
    this.usage?.record("generate", this.model, request.feature ?? "intelligence");
    const call = this.ai.models.generateContent({
      model: this.model,
      contents: request.prompt,
      config: {
        systemInstruction: request.system,
        responseMimeType: "application/json",
        temperature: request.temperature ?? 0.2,
        maxOutputTokens: request.maxOutputTokens ?? 8192,
      },
    });

    let response: any;
    try {
      response = await Promise.race([
        call,
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new IntelligenceError("aiTimeout", "The AI took too long to respond. Try again.", 504)),
            GENERATION_TIMEOUT_MS
          )
        ),
      ]);
    } catch (err) {
      if (err instanceof IntelligenceError) throw err;
      if (isGeminiQuotaError(err)) {
        throw new IntelligenceError(
          "quotaExceeded",
          "Gemini quota exceeded (HTTP 429). No further requests were sent — please retry later or check your Gemini plan and billing.",
          429
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new IntelligenceError(
        "aiUnavailable",
        `The AI request failed: ${message.slice(0, 200)}`,
        502
      );
    }

    const finishReason =
      typeof response?.candidates?.[0]?.finishReason === "string"
        ? response.candidates[0].finishReason
        : undefined;

    let text = "";
    try {
      text = typeof response?.text === "string" ? response.text : "";
    } catch {
      text = "";
    }

    if (!text.trim()) {
      throw new IntelligenceError(
        "emptyModelResponse",
        `The AI returned an empty response (${finishReason ? `finish reason: ${finishReason}` : "no content"}).`,
        502
      );
    }

    // MAX_TOKENS means the JSON was cut off even if the fragment happens to
    // parse. Surface it as its own code so the analysis pipeline can retry
    // with a smaller request instead of repeating the same oversized one.
    if (finishReason === "MAX_TOKENS") {
      throw new IntelligenceError(
        "modelOutputTruncated",
        `The AI response hit the ${request.maxOutputTokens ?? 8192}-token output limit and was cut off.`,
        502
      );
    }

    if (finishReason === "SAFETY" || finishReason === "RECITATION" || finishReason === "BLOCKLIST") {
      throw new IntelligenceError(
        "emptyModelResponse",
        `The AI declined to produce this response (finish reason: ${finishReason}).`,
        502
      );
    }

    return extractJson(text, { finishReason });
  }
}
