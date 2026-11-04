/**
 * Myra AI — Electron preload script (sandboxed).
 *
 * Exposes a minimal, narrow bridge:
 *   - `wsAuthToken` — the per-run, session-scoped WebSocket client credential.
 *     This is the ONLY credential the renderer holds. It grants nothing
 *     except connecting to 127.0.0.1:<port>/ws (the audio/Gemini Live
 *     session itself). It is NOT an API key and cannot mint any tool ticket;
 *     the HMAC key never leaves the main process.
 *   - `executeTool(payload)` — async invoke of the main-process Handoff
 *     Authority. The main process treats the payload as untrusted and
 *     re-validates everything (signature, registry, digest, expiry,
 *     single-use).
 *   - No Node APIs, no fs, no child_process, no unrestricted process access.
 */

const { contextBridge, ipcRenderer } = require("electron");

let wsAuthToken = null;
try {
  const value = ipcRenderer.sendSync("myra:auth:ws-token");
  wsAuthToken = typeof value === "string" && value.length > 0 ? value : null;
} catch {
  wsAuthToken = null;
}

contextBridge.exposeInMainWorld("myraDesktop", {
  isDesktop: true,
  platform: process.platform,
  appVersion: process.env.MYRA_APP_VERSION || "dev",
  runtime: {
    electron: typeof process.versions.electron === "string" ? process.versions.electron : "unknown",
    chrome: typeof process.versions.chrome === "string" ? process.versions.chrome : "unknown",
    node: typeof process.versions.node === "string" ? process.versions.node : "unknown",
  },

  // --- T5.0 trusted bridge (both validated in main process) ---
  wsAuthToken,
  executeTool: (payload) => {
    if (!payload || typeof payload !== "object") return Promise.resolve({ status: "denied", reason: "malformed" });
    return ipcRenderer.invoke("myra:tool:execute", payload);
  },
});
