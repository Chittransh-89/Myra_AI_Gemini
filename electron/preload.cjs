/**
 * Myra AI — Electron preload script (sandboxed).
 *
 * Exposes a minimal, read-only, non-privileged descriptor of the desktop
 * environment to the renderer. NO Node.js APIs, NO ipcRenderer, NO filesystem
 * or process access are exposed. The React app works with or without this
 * bridge (it is pure additive detection of "running inside Electron").
 */

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("myraDesktop", {
  isDesktop: true,
  platform: process.platform,
  appVersion: process.env.MYRA_APP_VERSION || "dev",
  runtime: {
    electron: typeof process.versions.electron === "string" ? process.versions.electron : "unknown",
    chrome: typeof process.versions.chrome === "string" ? process.versions.chrome : "unknown",
    node: typeof process.versions.node === "string" ? process.versions.node : "unknown",
  },
});
