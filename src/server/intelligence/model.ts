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

export interface TextModelRequest {
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface TextModel {
  readonly name: string;
  generateJSON(request: TextModelRequest): Promise<unknown>;
}

const GENERATION_TIMEOUT_MS = 90_000;

/** Parse the first JSON object/array in a model response. */
export function extractJson(raw: string): unknown {
  let text = String(raw ?? "").trim();
  if (!text) throw new IntelligenceError("emptyModelResponse", "The AI returned an empty response.", 502);

  // Strip a fenced block when present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  try {
    return JSON.parse(text);
  } catch {
    // Fall through to balanced-bracket extraction.
  }

  const firstObject = text.indexOf("{");
  const firstArray = text.indexOf("[");
  let start = -1;
  if (firstObject === -1) start = firstArray;
  else if (firstArray === -1) start = firstObject;
  else start = Math.min(firstObject, firstArray);

  if (start >= 0) {
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    const end = text.lastIndexOf(close);
    if (end > start) {
      const candidate = text.slice(start, end + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        try {
          return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
        } catch {
          /* fall through */
        }
      }
    }
  }

  throw new IntelligenceError(
    "invalidModelJson",
    "The AI response was not valid JSON. Try again; if it keeps failing, reduce the project size.",
    502
  );
}

export class GeminiTextModel implements TextModel {
  readonly name: string;
  private ai: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model = "gemini-2.5-flash") {
    this.name = model;
    this.model = model;
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generateJSON(request: TextModelRequest): Promise<unknown> {
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
      const message = err instanceof Error ? err.message : String(err);
      throw new IntelligenceError(
        "aiUnavailable",
        `The AI request failed: ${message.slice(0, 200)}`,
        502
      );
    }

    const text = typeof response?.text === "string" ? response.text : "";
    return extractJson(text);
  }
}
