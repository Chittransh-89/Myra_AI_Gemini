/**
 * Myra AI — local Gemini usage counter.
 *
 * Every Live session and every text-model request appends one JSON line to
 * `gemini-usage.jsonl`. No prompt/response content is stored: only timestamp,
 * kind, model and feature name. The status endpoint aggregates this file.
 *
 * This is a local convenience counter, not Google's billing record: a request
 * that never reaches Google (e.g. blocked locally) is still counted as an
 * attempt, and Google may bill tokens differently from request counts.
 */

import fs from "node:fs";
import path from "node:path";

export type GeminiUsageKind = "live" | "generate";

export interface GeminiUsageEvent {
  at: string;
  kind: GeminiUsageKind;
  model: string;
  feature: string;
}

export interface GeminiUsageSummary {
  totalRequests: number;
  liveSessions: number;
  generateContentRequests: number;
  byFeature: Record<string, number>;
  byModel: Record<string, number>;
  file: string;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
}

const USAGE_FILE = "gemini-usage.jsonl";

function bump(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

export class GeminiUsageTracker {
  readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, USAGE_FILE);
  }

  /** Best-effort: never let usage logging break an AI call. */
  record(kind: GeminiUsageKind, model: string, feature: string): void {
    const event: GeminiUsageEvent = {
      at: new Date().toISOString(),
      kind,
      model,
      feature,
    };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    } catch (err) {
      console.warn(
        "[usage] Could not record Gemini usage:",
        err instanceof Error ? err.message.slice(0, 160) : "unknown error"
      );
    }
  }

  summary(): GeminiUsageSummary {
    const summary: GeminiUsageSummary = {
      totalRequests: 0,
      liveSessions: 0,
      generateContentRequests: 0,
      byFeature: {},
      byModel: {},
      file: this.filePath,
      firstRecordedAt: null,
      lastRecordedAt: null,
    };

    let raw = "";
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return summary;
    }

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // ignore a torn/corrupt final line
      }
      if (event?.kind !== "live" && event?.kind !== "generate") continue;

      const model = typeof event.model === "string" && event.model ? event.model : "unknown";
      const feature = typeof event.feature === "string" && event.feature ? event.feature : "unknown";
      const at = typeof event.at === "string" ? event.at : null;

      summary.totalRequests += 1;
      if (event.kind === "live") summary.liveSessions += 1;
      else summary.generateContentRequests += 1;
      bump(summary.byFeature, feature);
      bump(summary.byModel, model);

      if (at) {
        if (!summary.firstRecordedAt || at < summary.firstRecordedAt) summary.firstRecordedAt = at;
        if (!summary.lastRecordedAt || at > summary.lastRecordedAt) summary.lastRecordedAt = at;
      }
    }

    return summary;
  }
}
