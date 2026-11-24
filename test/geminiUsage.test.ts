/**
 * Local Gemini usage counter: JSONL recording and the status endpoint.
 * Uses LocalProvider so no Gemini session or text request is made.
 */

import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { GeminiUsageTracker } from "../src/server/geminiUsage.js";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myra-gemini-usage-"));
  const tracker = new GeminiUsageTracker(dataDir);

  tracker.record("live", "gemini-3.1-flash-live-preview", "voice");
  tracker.record("generate", "gemini-2.5-flash", "interview.answer");
  tracker.record("generate", "gemini-2.5-flash", "project.analysis.extraction");
  tracker.record("generate", "gemini-2.5-flash", "interview.answer");

  // A torn/corrupt line must not break the totals.
  fs.appendFileSync(tracker.filePath, "{not json\n", "utf8");

  const summary = tracker.summary();
  check(summary.totalRequests === 4, "total must count every valid event");
  check(summary.liveSessions === 1, "live sessions must be counted separately");
  check(summary.generateContentRequests === 3, "generateContent calls must be counted");
  check(summary.byFeature["interview.answer"] === 2, "feature counts must be aggregated");
  check(summary.byModel["gemini-2.5-flash"] === 3, "model counts must be aggregated");
  check(summary.firstRecordedAt !== null && summary.lastRecordedAt !== null, "timestamps must be summarised");

  process.env.AI_PROVIDER = "local";
  process.env.NODE_ENV = "production";
  process.env.PORT = "0";
  process.env.HOST = "127.0.0.1";
  process.env.MYRA_INTELLIGENCE = "0";
  process.env.MYRA_REMOTE = "0";

  const { loadConfig } = await import("../src/server/config.js");
  const { LocalProvider } = await import("../src/server/providers/local.js");
  const { startServer } = await import("../src/server/index.js");

  const server = await startServer(new LocalProvider(), loadConfig(), tracker);

  try {
    let port = 0;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const address = server.address();
      if (address && typeof address === "object") {
        port = (address as AddressInfo).port;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(port > 0, "server must report its listening port");
    const base = `http://127.0.0.1:${port}`;

    let response: Response | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        response = await fetch(`${base}/api/gemini/usage`);
        if (response.status > 0) break;
      } catch {
        // server is still binding
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(response !== null, "usage endpoint must become reachable");
    check(response.status === 200, "usage endpoint must answer on loopback");
    check((response.headers.get("cache-control") ?? "").includes("no-store"), "usage must not be cached");
    const body: any = await response.json();
    check(body.ok === true, "usage response must be ok");
    check(body.usage.totalRequests === 4, "endpoint must expose the total");
    check(body.usage.liveSessions === 1, "endpoint must expose live sessions");
    check(body.usage.generateContentRequests === 3, "endpoint must expose generateContent calls");
    check(body.usage.byFeature["interview.answer"] === 2, "endpoint must expose per-feature counts");
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log("geminiUsage: all checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
