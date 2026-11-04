/**
 * Myra AI — Root server entry point.
 *
 * This file was refactored as part of Phase 1 (AI Provider Abstraction).
 * All server logic now lives in src/server/index.ts.
 * All Gemini-specific logic now lives in src/server/providers/gemini.ts.
 * Environment config is centralised in src/server/config.ts.
 *
 * The external behaviour (WebSocket protocol, HTTP endpoints, Vite middleware)
 * is completely unchanged. App.tsx, audioPlayer.ts and audioStreamer.ts were
 * not modified.
 */

import dotenv from "dotenv";
dotenv.config();

import { loadConfig } from "./src/server/config.js";
import { createProvider } from "./src/server/providers/index.js";
import { startServer } from "./src/server/index.js";

async function main() {
  const config = loadConfig();
  const provider = await createProvider(config);
  await startServer(provider, config);
}

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  process.exit(1);
});
