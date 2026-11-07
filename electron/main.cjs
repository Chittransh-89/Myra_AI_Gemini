/**
 * Myra AI — Electron main process.
 *
 * Responsibilities:
 *  - Boot the EXISTING Myra Node server (no logic rewritten):
 *      development  -> spawns `tsx server.ts` as a child process
 *                      (ELECTRON_RUN_AS_NODE makes it behave like plain node)
 *      production   -> requires the esbuild-bundled `dist/server.cjs`
 *                      in-process (NODE_ENV=production skips Vite middleware)
 *  - Wait for /api/health to respond, then open a BrowserWindow that loads
 *    http://127.0.0.1:<port> — the same React app the website serves.
 *  - Secure defaults: contextIsolation, no nodeIntegration, sandboxed preload.
 *  - T5.0 trust stack (main-process owned):
 *      * per-run WS auth token  -> renderer may connect to /ws (nothing else)
 *      * Handoff Authority      -> the ONLY ticket minter (HMAC, single-use,
 *                                  monotonic expiry, arg-digest bound)
 *      * named pipe + nonce     -> trusted server->authority registration
 *                                  channel (both dev child and in-process)
 *      * kill switch            -> global hotkey + tray; aborts pending tool
 *                                  registrations and blocks execution
 *      * audit logger           -> redacted append-only JSONL metadata
 *  - Graceful shutdown: child server killed (process-tree kill on Windows)
 *    before the app quits, so no orphaned server remains.
 *
 * Env flags (internal/testing):
 *  MYRA_SMOKE=1  — headless smoke-test mode (T5.0 trust-stack suite included)
 *  MYRA_PROD=1   — force the production (in-process bundled server) path
 */

const { app, BrowserWindow, dialog, Tray, Menu, globalShortcut, nativeImage, ipcMain } = require("electron");
const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const zlib = require("zlib");

const { createAuditLogger } = require("./lib/auditLogger.cjs");
const { createKillSwitch } = require("./lib/killSwitch.cjs");
const { createHandoffAuthority, createHandoffPipeServer } = require("./lib/handoffAuthority.cjs");
const { createBrowserController } = require("./lib/browserControl.cjs");
const { createWhatsAppBridge } = require("./lib/whatsappControl.cjs");
const { createPhoneBridge } = require("./lib/phoneControl.cjs");
const { createProjectControl } = require("./lib/projectControl.cjs");
const { createFileControl } = require("./lib/fileControl.cjs");

const PORT = parseInt(process.env.PORT || "3000", 10);
const APP_URL = `http://127.0.0.1:${PORT}`;
const PROJECT_ROOT = path.join(__dirname, "..");
const SMOKE = process.env.MYRA_SMOKE === "1";
const PROD_MODE = app.isPackaged || process.env.MYRA_PROD === "1";

let serverChild = null;
let mainWindow = null;
let tray = null;
let quitting = false;
let smokeDone = false;

// T5.0/T5R: console scanner used by the smoke harness to observe server-side
// markers regardless of server topology (child pipe or in-process).
let smokeTamperMarkerSeen = false;
let smokeSessionId = null;
const TAMPER_MARKER = "[tamper] DROPPED_TOOL_RESPONSE";
const smokeMarkers = new Set();
const smokeMarkerCounts = new Map(); // occurrence counts (exactly-once assertions)
const MARKER_RX = /\[tamper\]\s*[A-Z_]+|\[smoke\]\s*[A-Z_]+/g;

function scanForSmokeMarkers(text) {
  if (!SMOKE || typeof text !== "string") return;
  if (text.includes(TAMPER_MARKER)) smokeTamperMarkerSeen = true;
  let m;
  MARKER_RX.lastIndex = 0;
  while ((m = MARKER_RX.exec(text)) !== null) {
    const token = m[0].replace(/\s+/g, " ");
    smokeMarkers.add(token);
    smokeMarkerCounts.set(token, (smokeMarkerCounts.get(token) || 0) + 1);
  }
  const s = text.match(/\[smoke\] SESSION_ID=([A-Za-z0-9_-]+)/);
  if (s) smokeSessionId = s[1];
}

// Wrap console.log so in-process (production) server markers are captured too.
const origConsoleLog = console.log.bind(console);
console.log = (...args) => {
  scanForSmokeMarkers(args.map((a) => (typeof a === "string" ? a : "")).join(" "));
  origConsoleLog(...args);
};

function log(...args) {
  origConsoleLog("[electron-main]", ...args);
}

// ---------------------------------------------------------------------------
// T5.0 trust stack bootstrap
// ---------------------------------------------------------------------------

const RUN_ID = crypto.randomBytes(8).toString("hex");
const WS_TOKEN = crypto.randomBytes(32).toString("hex"); // per-run, never logged
const HANDOFF_NONCE = crypto.randomBytes(32).toString("hex"); // per-run, never logged
const RECEIPT_KEY_HEX = crypto.randomBytes(32).toString("hex"); // completion HMAC key, shared with the server via env only
const HANDOFF_PIPE = `myra-handoff-${RUN_ID}`; // nonce-gated; name itself carries no privilege

const auditLog = createAuditLogger(app.getPath("userData"), RUN_ID);
const audit = auditLog.audit.bind(auditLog); // callable used across the trust stack

// Phase C: the ONLY component allowed to touch a browser. It owns a dedicated
// Chromium profile and a loopback-only CDP endpoint; the renderer never sees
// either. See electron/lib/browserControl.cjs for the full threat model.
const browserControl = createBrowserController({
  audit,
  log,
  userDataDir: app.getPath("userData"),
});
// Messaging: WhatsApp drives the user's own WhatsApp Web session in Myra's
// browser; Phone Link is report-only because Windows exposes no calling API.
const whatsappControl = createWhatsAppBridge({ browser: browserControl, audit, log });
const phoneControl = createPhoneBridge({
  audit,
  log,
  openExternal: (target) => require("electron").shell.openExternal(target),
});
// VS Code project builder: filesystem writes happen only here, only after a
// plan was read back to the user and approved by its one-time planId.
const projectControl = createProjectControl({
  audit,
  log,
  pickFolder: async () => {
    const { dialog, BrowserWindow } = require("electron");
    const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const options = { properties: ["openDirectory"], title: "Select a reference folder for Myra" };
    const res = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (!res || res.canceled || !res.filePaths || !res.filePaths.length) return { canceled: true };
    return { canceled: false, path: res.filePaths[0] };
  },
});
// File access: the ONLY component allowed to read user files. It keeps the
// per-session authorization list and the open-file context in main; the
// renderer can only trigger the native picker (a user gesture).
const fileControl = createFileControl({
  audit,
  log,
  pickFiles: async () => {
    const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const options = {
      title: "Open a file for Myra",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Readable files",
          extensions: [
            "txt", "md", "pdf", "docx", "csv", "json", "js", "ts", "jsx", "tsx",
            "py", "html", "css", "xml", "yml", "yaml", "log", "sql", "java", "go", "rs",
          ],
        },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const res = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return { canceled: !!(res && res.canceled), paths: (res && res.filePaths) || [] };
  },
  confirmPath: async (filePath) => {
    const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const options = {
      type: "question",
      title: "Myra file access",
      message: "Allow Myra to read this file?",
      detail: filePath + "\n\nMyra sends the extracted text to Gemini for this conversation. Nothing is uploaded elsewhere and file contents are never executed.",
      buttons: ["Allow Myra to read", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const res = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return res && res.response === 0;
  },
  onState: (state) => broadcastFileState(state),
});
const killSwitch = createKillSwitch((state) => {
  audit(state.engaged ? "KILL_ENGAGED" : "KILL_RELEASED", { reason: state.lastReason });
  log("Kill switch:", state.engaged ? "ENGAGED" : "released", "(" + state.lastReason + ")");
  // T5R: a generation bump invalidates in-flight async executions — their
  // completions are suppressed rather than delivered.
  if (state.engaged && typeof authority.advanceGeneration === "function") {
    authority.advanceGeneration();
  }
});
const authority = createHandoffAuthority({
  audit,
  killSwitch,
  receiptKey: Buffer.from(RECEIPT_KEY_HEX, "hex"),
  browser: browserControl,
  whatsapp: whatsappControl,
  phone: phoneControl,
  project: projectControl,
  file: fileControl,
  emitCompletion: (frame) => (pipeServer ? pipeServer.broadcast(frame) : false),
  notifyExecuting: (callId, sessionId) => {
    if (pipeServer) pipeServer.broadcast({ type: "execStatus", callId, sessionId, state: "executing" });
  },
});
let pipeServer = null;

function buildServerEnv() {
  return {
    ...process.env,
    MYRA_ELECTRON: "1",
    MYRA_WS_TOKEN: WS_TOKEN,
    MYRA_HANDOFF_PIPE: HANDOFF_PIPE,
    MYRA_HANDOFF_NONCE: HANDOFF_NONCE,
    MYRA_RECEIPT_KEY: RECEIPT_KEY_HEX,
  };
}

function broadcastFileState(state) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send("myra:file:state", state);
      } catch {
        /* window closing */
      }
    }
  }
}

function registerIpcHandlers() {
  // Preload reads the per-run WS credential exactly once, synchronously.
  ipcMain.on("myra:auth:ws-token", (event) => {
    event.returnValue = WS_TOKEN;
  });

  // File access surface for the renderer. These only open the native picker,
  // read the current context state, or clear the context — they can never
  // read an arbitrary path. Actual reads happen through the Handoff Authority.
  ipcMain.handle("myra:file:pick", async () => fileControl.pickFromUi());
  ipcMain.handle("myra:file:state:get", () => fileControl.getState());
  ipcMain.handle("myra:file:close", () => fileControl.closeFromUi());

  // The renderer's ONLY tool path. Everything is validated inside the
  // authority (signature, registry membership, expiry, single-use, digest).
  ipcMain.handle("myra:tool:execute", async (_event, payload) => {
    audit("EXECUTE_REQUEST", { source: "renderer", tool: typeof payload?.name === "string" ? payload.name : "?" });
    return authority.handleExecuteTool(payload);
  });
}

// ---------------------------------------------------------------------------
// Kill switch user surfaces: global hotkey + tray (main-process owned)
// ---------------------------------------------------------------------------

/** Generates a solid-colour 16x16 PNG at runtime (no asset files needed). */
function makeSolidPng(r, g, b, size = 16) {
  const raw = Buffer.alloc(size * (1 + size * 3));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  return nativeImage.createFromBuffer(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", idat),
      chunk("IEND", Buffer.alloc(0)),
    ])
  );
}

function updateTray() {
  if (!tray) return;
  const active = killSwitch.isActive();
  tray.setImage(makeSolidPng(active ? 220 : 34, active ? 60 : 197, active ? 60 : 238)); // red / cyan
  tray.setToolTip(active ? "Myra AI — KILLED (all tool activity stopped)" : "Myra AI — running");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: active ? "Resume Myra activity" : "Kill all Myra activity",
        click: () => toggleKill("tray"),
      },
      { type: "separator" },
      { label: "Quit Myra", click: () => app.quit() },
    ])
  );
}

function toggleKill(source) {
  const state = killSwitch.toggle(source);
  if (state.engaged) {
    const aborted = authority.abortPending("killSwitchEngaged");
    log(`KILL SWITCH engaged via ${source} — ${aborted} pending tool registration(s) aborted`);
  } else {
    log(`Kill switch released via ${source}`);
  }
  updateTray();
}

function registerKillSurfaces() {
  try {
    globalShortcut.register("Control+Alt+Shift+Space", () => toggleKill("hotkey-space"));
    globalShortcut.register("Control+Alt+Shift+K", () => toggleKill("hotkey-k"));
  } catch (err) {
    log("Global shortcut registration failed:", err.message);
  }
  try {
    tray = new Tray(makeSolidPng(34, 197, 238));
    updateTray();
  } catch (err) {
    log("Tray creation failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Optional user-level env overrides (packaged mode only).
// ---------------------------------------------------------------------------

function loadUserEnv() {
  try {
    const envPath = path.join(app.getPath("userData"), ".env");
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
    log("Loaded optional env overrides from:", envPath);
  } catch (err) {
    log("Could not load user env overrides:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Server child process (development mode)
// ---------------------------------------------------------------------------

function startDevServer() {
  const tsxCli = require.resolve("tsx/cli");
  const env = {
    ...buildServerEnv(),
    // Makes the Electron binary act as a plain Node interpreter — avoids any
    // dependency on a system-installed `node` being on PATH.
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
  };
  serverChild = spawn(process.execPath, [tsxCli, "server.ts"], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverChild.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    scanForSmokeMarkers(text);
    process.stdout.write("[server] " + text);
  });
  serverChild.stderr.on("data", (chunk) => process.stderr.write("[server:err] " + chunk));
  serverChild.on("exit", (code, signal) => {
    log("Dev server child exited with code", code, "signal", signal);
    serverChild = null;
  });
}

function killServerChild() {
  if (!serverChild) return;
  const child = serverChild;
  const pid = child.pid;
  serverChild = null;
  if (process.platform === "win32") {
    // tsx spawns its own children; kill the whole tree so port 3000 frees up.
    exec(`taskkill /pid ${pid} /T /F`, () => {});
  } else {
    try {
      child.kill("SIGTERM");
    } catch (err) {
      /* already gone */
    }
  }
  log("Server child killed (pid", pid + ")");
}

// ---------------------------------------------------------------------------
// Server readiness / smoke helpers
// ---------------------------------------------------------------------------

function waitForServer(timeoutMs = 45000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`${APP_URL}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        return res.socket.destroy(), retry();
      });
      req.on("error", retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });

      function retry() {
        if (Date.now() - started > timeoutMs) {
          return reject(new Error("Server did not become healthy in time"));
        }
        setTimeout(attempt, 500);
      }
    };
    attempt();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let smokeWs = null; // held-open WS connection used by the Phase B completion checks

/** Opens a WS with an optional ?auth= value and resolves on the first status frame. */
function wsAuthProbe(authValue, { expectGemini = false, sendTamperProbe = false, keepOpen = false } = {}) {
  return new Promise((resolve) => {
    const { WebSocket } = require("ws");
    const suffix = authValue === null ? "" : `?auth=${encodeURIComponent(authValue)}`;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${suffix}`);
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (!keepOpen) {
        try {
          ws.close();
        } catch {}
      } else {
        smokeWs = ws; // held open for the Phase B completion checks
      }
      resolve(result);
    };
    const timer = setTimeout(() => done("timeout"), 30000);
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "status") {
          if (msg.state === "connected") {
            clearTimeout(timer);
            if (sendTamperProbe) {
              // Server-side toolResponse validation probe (Phase B.1):
              //  - "smoke-bogus-never-registered" was never forwarded -> unknown callId.
              //  - "smoke-completion-1" IS registered (smoke hook) and
              //    main-executed -> renderer-authored result must be rejected
              //    even with the pipe fully active.
              ws.send(
                JSON.stringify({
                  type: "toolResponse",
                  functionResponses: [
                    { name: "bogusTool", response: { output: 1 }, id: "smoke-bogus-never-registered" },
                    { name: "getSystemTime", response: { output: { time: "FAKE" } }, id: "smoke-completion-1" },
                  ],
                })
              );
              setTimeout(() => {
                clearTimeout(timer);
                done("connected+probed");
              }, 1200);
            } else {
              done("connected");
            }
          } else if (msg.state === "error") {
            clearTimeout(timer);
            done("rejected:" + (msg.message || "error"));
          }
        }
      } catch {}
    });
    ws.on("close", () => {
      if (!settled) {
        clearTimeout(timer);
        done("closed-no-status");
      }
    });
    ws.on("error", () => {
      if (!settled) {
        clearTimeout(timer);
        done("ws-error");
      }
    });
  });
}

async function runSmokeChecks() {
  if (!SMOKE || smokeDone) return;
  smokeDone = true;

  const fail = (msg) => {
    console.log("[smoke] FAIL:", msg);
    dialog.showErrorBox("Myra smoke test", msg);
    app.exit(1);
  };

  try {
    // ---- A. Renderer + sandbox basics ------------------------------------
    const rendered = await mainWindow.webContents.executeJavaScript(
      '!!document.getElementById("root") && document.getElementById("root").childElementCount > 0'
    );
    console.log("[smoke] React rendered:", rendered);
    if (!rendered) return fail("React did not mount into #root");

    const requireAvailable = await mainWindow.webContents.executeJavaScript("typeof require");
    console.log("[smoke] renderer `typeof require`:", requireAvailable);
    if (requireAvailable !== "undefined") return fail("Renderer has access to CommonJS require — sandbox check failed");

    const nodeGlobals = await mainWindow.webContents.executeJavaScript(
      'JSON.stringify({fs: typeof window.fs, child_process: typeof window.child_process, ipcRenderer: typeof window.ipcRenderer, myraDesktop: typeof window.myraDesktop})'
    );
    console.log("[smoke] renderer global API check:", nodeGlobals);

    // ---- B. WS authentication --------------------------------------------
    const invalidResult = await wsAuthProbe("definitely-wrong-token-123");
    console.log("[smoke] WS invalid-token result:", invalidResult);
    if (!String(invalidResult).startsWith("rejected:")) return fail("Invalid WS token was not rejected");

    const noTokenResult = await wsAuthProbe(null);
    console.log("[smoke] WS no-token result:", noTokenResult);
    if (!String(noTokenResult).startsWith("rejected:")) return fail("Missing WS token was not rejected");

    const validResult = await wsAuthProbe(WS_TOKEN, { expectGemini: true, sendTamperProbe: true, keepOpen: true });
    console.log("[smoke] WS valid-token result:", validResult);
    if (!String(validResult).startsWith("connected")) return fail("Valid WS token did not reach a Gemini session");
    console.log("[smoke] Gemini Live session established over authenticated WS (voice regression OK)");

    await sleep(400);
    console.log("[smoke] server-side tamper-drop marker observed:", smokeTamperMarkerSeen);

    // ---- B.1 regressions: Electron mode + ACTIVE pipe ----------------------
    // (1) Unknown callId rejected. (2) Renderer-authored result for a
    // registered MAIN-EXECUTED call rejected (HIGH-1 fix, active-pipe case).
    if (!smokeMarkers.has("[tamper] DROPPED_TOOL_RESPONSE_UNREGISTERED")) {
      return fail("B.1: renderer toolResponse with unknown callId was not rejected");
    }
    console.log("[smoke] B.1 unknown-callId toolResponse rejected: true");
    if (!smokeMarkers.has("[tamper] DROPPED_TOOL_RESPONSE_MAIN_EXECUTED")) {
      return fail("B.1: renderer-authored result for a main-executed tool was not rejected");
    }
    console.log("[smoke] B.1 main-executed toolResponse rejected (active pipe): true");

    // ---- C. Handoff ticket security (via the real renderer IPC path) ------
    const forged = await mainWindow.webContents.executeJavaScript(
      `window.myraDesktop.executeTool({ticket: "eyJjIjoiZmFrZSIsIm4iOiJnZXRTeXN0ZW1UaW1lIiwiZCI6ImRlYWRiZWVmIiwiZSI6IjAiLCJzIjoiYWFkZCJ9", name: "getSystemTime", args: {}})`
    );
    console.log("[smoke] forged-ticket result:", JSON.stringify(forged));
    if (forged?.status !== "denied") return fail("Forged ticket was not rejected");

    // Genuine registration (simulates the server-side pipe registration)
    const reg1 = authority.registerPendingCall({ callId: "smoke-1", toolName: "getSystemTime", args: { probe: 1 }, sessionId: "smoke-local-0001" });
    if (!reg1.ok) return fail("authority registration failed: " + reg1.reason);
    const ok1 = await mainWindow.webContents.executeJavaScript(
      `window.myraDesktop.executeTool(${JSON.stringify({ ticket: reg1.ticket, name: "getSystemTime", args: { probe: 1 } })})`
    );
    console.log("[smoke] valid-ticket result:", JSON.stringify(ok1));
    if (ok1?.status !== "ok" || !ok1?.output?.time) return fail("Valid ticket did not execute");

    const replay = await mainWindow.webContents.executeJavaScript(
      `window.myraDesktop.executeTool(${JSON.stringify({ ticket: reg1.ticket, name: "getSystemTime", args: { probe: 1 } })})`
    );
    console.log("[smoke] replay result:", JSON.stringify(replay));
    if (replay?.status !== "denied" || replay?.reason !== "replay") return fail("Replayed ticket was not rejected as replay");

    const reg2 = authority.registerPendingCall({ callId: "smoke-2", toolName: "getSystemTime", args: { probe: 1 }, sessionId: "smoke-local-0001" });
    if (!reg2.ok) return fail("authority registration 2 failed");
    const tampered = await mainWindow.webContents.executeJavaScript(
      `window.myraDesktop.executeTool(${JSON.stringify({ ticket: reg2.ticket, name: "getSystemTime", args: { probe: 2 } })})`
    );
    console.log("[smoke] args-tamper result:", JSON.stringify(tampered));
    if (tampered?.status !== "denied" || tampered?.reason !== "argsTampered") return fail("Argument tampering was not rejected");

    const reg3 = authority.registerPendingCall({ callId: "smoke-3", toolName: "getSystemTime", args: {}, maxAgeMs: 120, sessionId: "smoke-local-0001" });
    if (!reg3.ok) return fail("authority registration 3 failed");
    await sleep(500);
    const expired = await mainWindow.webContents.executeJavaScript(
      `window.myraDesktop.executeTool(${JSON.stringify({ ticket: reg3.ticket, name: "getSystemTime", args: {} })})`
    );
    console.log("[smoke] expired-ticket result:", JSON.stringify(expired));
    if (expired?.status !== "denied" || expired?.reason !== "expired") return fail("Expired ticket was not rejected");

    // ---- F. T5R Phase B: authenticated completion channel -----------------
    // The server pre-registers a synthetic pending call ("smoke-completion-1")
    // on the held-open WS session and logs its sessionId in smoke mode. Main
    // holds the receipt key, so it can mint both valid and adversarial
    // completions and observe the server's verdicts via log markers.
    if (!smokeSessionId) return fail("Phase B: server session id was not captured");
    // Drain + clear: markers emitted by the section-B/C denial completions
    // (e.g. COMPLETION_UNKNOWN_SESSION for smoke-1/2/3) must not satisfy the
    // section-F waits. Each F check must observe its OWN frame's verdict.
    smokeMarkers.clear();
    await sleep(500);
    const iv = require("./lib/ipcValidate.cjs");
    const receiptKeyBuf = Buffer.from(RECEIPT_KEY_HEX, "hex");
    const GOOD_RESULT = { time: "12:00:00", date: "1/1/2026", timezone: "UTC", executedIn: "main-process" };
    const mkReceipt = (overrides, badSig) => {
      const receipt = {
        v: 1,
        kind: "completion",
        callId: "smoke-completion-1",
        toolName: "getSystemTime",
        sessionId: smokeSessionId,
        argsDigest: iv.sha256Hex("{}"),
        executionStatus: "success",
        result: GOOD_RESULT,
        resultDigest: iv.sha256Hex(iv.strictCanonicalJson(GOOD_RESULT)),
        reason: null,
        nonce: crypto.randomBytes(16).toString("hex"),
        issuedAtMs: Date.now(),
        ...overrides,
      };
      const { sig, ...payloadFields } = receipt;
      const canonical = iv.strictCanonicalJson(payloadFields);
      receipt.sig = badSig ? "00".repeat(32) : iv.hmacHex(receiptKeyBuf, iv.COMPLETION_DOMAIN, canonical);
      return receipt;
    };
    const broadcast = (receipt) => pipeServer.broadcast({ type: "completion", receipt });
    const waitMarker = async (marker, timeoutMs = 2500) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (smokeMarkers.has(marker)) return true;
        await sleep(50);
      }
      return smokeMarkers.has(marker);
    };

    // F1: bad signature must be rejected.
    broadcast(mkReceipt({}, true));
    if (!(await waitMarker("[tamper] COMPLETION_BAD_SIGNATURE"))) return fail("Phase B: bad-signature completion was not rejected");
    console.log("[smoke] F1 bad-signature completion rejected: true");

    // F2: valid signature but never-registered callId must be rejected.
    broadcast(mkReceipt({ callId: "smoke-never-registered" }));
    if (!(await waitMarker("[tamper] COMPLETION_UNREGISTERED"))) return fail("Phase B: unregistered completion was not rejected");
    console.log("[smoke] F2 unregistered completion rejected: true");

    // F3: valid signature but foreign sessionId must be rejected.
    broadcast(mkReceipt({ sessionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
    if (!(await waitMarker("[tamper] COMPLETION_UNKNOWN_SESSION"))) return fail("Phase B: cross-session completion was not rejected");
    console.log("[smoke] F3 cross-session completion rejected: true");

    // F4: valid completion must be accepted and forwarded to Gemini.
    const validReceipt = mkReceipt({});
    broadcast(validReceipt);
    if (!(await waitMarker("[smoke] COMPLETION_ACCEPTED"))) return fail("Phase B: valid completion was not accepted");
    console.log("[smoke] F4 valid completion accepted: true");

    // F5: replaying the SAME receipt must be rejected (terminal state; nonce cache).
    broadcast(validReceipt);
    if (!(await waitMarker("[tamper] COMPLETION_TERMINAL"))) return fail("Phase B: replayed completion was not rejected");
    console.log("[smoke] F5 replayed completion rejected: true");

    // F6: altered result against the signed digest must be rejected.
    broadcast(mkReceipt({ callId: "smoke-completion-2", result: { time: "EVIL" } }));
    if (!(await waitMarker("[tamper] COMPLETION_DIGEST_MISMATCH"))) return fail("Phase B: altered completion result was not rejected");
    console.log("[smoke] F6 altered-result completion rejected: true");

    // F7: tool-name binding mismatch must be rejected.
    broadcast(mkReceipt({ callId: "smoke-completion-3", toolName: "openWebsite" }));
    if (!(await waitMarker("[tamper] COMPLETION_BINDING_MISMATCH"))) return fail("Phase B: tool-mismatched completion was not rejected");
    console.log("[smoke] F7 tool-mismatched completion rejected: true");

    // F8: oversized frame must destroy the connection. NOTE: on Windows named
    // pipes the client only observes a server-side destroy on its next I/O
    // operation, so the probe writes after the flood and treats EPIPE/close
    // as confirmation.
    const oversizedClosed = await new Promise((resolve) => {
      const s = net.connect(require("./lib/handoffAuthority.cjs").toPipePath(HANDOFF_PIPE));
      let closed = false;
      const finish = (v) => {
        if (!closed) {
          closed = true;
          resolve(v);
        }
      };
      s.on("close", () => finish(true));
      s.on("end", () => finish(true));
      s.on("error", () => finish(true));
      s.on("connect", () => {
        s.write("A".repeat(200 * 1024));
        setTimeout(() => {
          try {
            s.write("probe\n"); // forces the client to observe the destroyed pipe
          } catch {
            finish(true);
          }
        }, 500);
      });
      setTimeout(() => finish(false), 3000);
    });
    console.log("[smoke] F8 oversized frame destroyed connection:", oversizedClosed);
    if (!oversizedClosed) return fail("Phase B: oversized pipe frame did not destroy the connection");

    // F9: frame flood must trip the rate limit and destroy the connection.
    const floodedClosed = await new Promise((resolve) => {
      const s = net.connect(require("./lib/handoffAuthority.cjs").toPipePath(HANDOFF_PIPE));
      let closed = false;
      const finish = (v) => {
        if (!closed) {
          closed = true;
          resolve(v);
        }
      };
      s.on("close", () => finish(true));
      s.on("end", () => finish(true));
      s.on("error", () => finish(true));
      s.on("connect", () => {
        s.write(JSON.stringify({ type: "hello", nonce: HANDOFF_NONCE }) + "\n");
        for (let i = 1; i <= 100; i++) {
          s.write(
            JSON.stringify({
              type: "register",
              callId: "flood-" + i,
              toolName: "getSystemTime",
              argsDigest: "0".repeat(64),
              sessionId: "floodsess00",
            }) + "\n"
          );
        }
        setTimeout(() => {
          try {
            s.write("probe\n"); // forces the client to observe the destroyed pipe
          } catch {
            finish(true);
          }
        }, 500);
      });
      setTimeout(() => finish(false), 3000);
    });
    console.log("[smoke] F9 frame flood destroyed connection:", floodedClosed);
    if (!floodedClosed) return fail("Phase B: pipe frame flood did not trip the rate limit");

    // ---- G. T5R Phase B.1: fail-closed lifecycle regressions ---------------
    // Simulate a pipe outage: destroy the authenticated pipe sockets (the
    // server's handoff client goes inactive) and close the listener so it
    // cannot reconnect. Renderer-authority must survive this state (HIGH-1).
    smokeMarkers.clear();
    smokeMarkerCounts.clear();
    const droppedClients = pipeServer ? pipeServer.dropClients() : 0;
    if (pipeServer) pipeServer.close();
    await sleep(400); // let the client-side teardown propagate
    console.log("[smoke] G0 pipe outage simulated (clients dropped:", droppedClients, ", listener closed)");

    // G1: renderer-authored result for a registered MAIN-EXECUTED call during
    // the outage must still be rejected (smoke-completion-2 was left open by
    // F6's digest-mismatch rejection — not terminal, not done).
    smokeWs.send(
      JSON.stringify({
        type: "toolResponse",
        functionResponses: [{ name: "getSystemTime", response: { output: { time: "FAKE" } }, id: "smoke-completion-2" }],
      })
    );
    if (!(await waitMarker("[tamper] DROPPED_TOOL_RESPONSE_MAIN_EXECUTED"))) {
      return fail("B.1: main-executed toolResponse was accepted during a pipe outage");
    }
    console.log("[smoke] G1 main-executed toolResponse rejected (pipe outage): true");

    // G2: unknown callId during the outage must be rejected.
    smokeWs.send(
      JSON.stringify({
        type: "toolResponse",
        functionResponses: [{ name: "getSystemTime", response: { output: { time: "FAKE" } }, id: "smoke-unknown-outage" }],
      })
    );
    if (!(await waitMarker("[tamper] DROPPED_TOOL_RESPONSE_UNREGISTERED"))) {
      return fail("B.1: unknown callId was accepted during a pipe outage");
    }
    console.log("[smoke] G2 unknown callId rejected (pipe outage): true");

    // G3: registration failure during the outage -> the SERVER synthesizes
    // the tool error and delivers it to Gemini itself. The harness sends only
    // the smoke hook message — no renderer toolResponse participates.
    smokeWs.send(JSON.stringify({ type: "smokeRegFail", callId: "smoke-regfail-1" }));
    if (!(await waitMarker("[smoke] REGFAIL_SYNTHESIZED"))) {
      return fail("B.1: failed registration did not produce a server-synthesized error");
    }
    console.log("[smoke] G3 server-synthesized error for failed registration: true");

    // G4: duplicate registration must not overwrite the existing entry and
    // must not generate a second synthesized response.
    smokeWs.send(JSON.stringify({ type: "smokeRegFail", callId: "smoke-regfail-1" }));
    if (!(await waitMarker("[smoke] DUPLICATE_CALLID_PRESERVED"))) {
      return fail("B.1: duplicate callId did not preserve the existing entry");
    }
    console.log("[smoke] G4 duplicate callId preserved: true");

    // G5: exactly-once — exactly ONE synthesized response may ever exist.
    const synthCount = smokeMarkerCounts.get("[smoke] REGFAIL_SYNTHESIZED") || 0;
    if (synthCount !== 1) return fail("B.1: expected exactly 1 synthesized response, saw " + synthCount);
    console.log("[smoke] G5 exactly-one synthesized response: true");

    // G6: the preserved entry is still terminal — a renderer response for the
    // duplicated callId is rejected, proving no overwrite/reset occurred.
    smokeWs.send(
      JSON.stringify({
        type: "toolResponse",
        functionResponses: [{ name: "getSystemTime", response: { output: { error: "handoffUnavailable" } }, id: "smoke-regfail-1" }],
      })
    );
    if (!(await waitMarker("[tamper] DROPPED_TOOL_RESPONSE_TERMINAL"))) {
      return fail("B.1: preserved entry was overwritten or reset by the duplicate registration");
    }
    console.log("[smoke] G6 preserved entry remained terminal: true");

    try {
      smokeWs && smokeWs.close();
    } catch {}

    // ---- D. Kill switch (renderer frozen; enforcement is main-side) -------
    // Freeze the renderer's JS loop for ~8s to prove the kill switch works
    // without renderer cooperation.
    mainWindow.webContents.executeJavaScript("const t0=Date.now(); while(Date.now()-t0<8000){} 'unfrozen'");
    await sleep(400);

    const engaged = killSwitch.engage("smoke-hotkey");
    console.log("[smoke] kill switch engaged:", JSON.stringify(engaged));
    if (!killSwitch.isActive()) return fail("Kill switch did not engage");

    const regDuringKill = authority.registerPendingCall({ callId: "smoke-4", toolName: "getSystemTime", args: {}, sessionId: "smoke-local-0001" });
    console.log("[smoke] registration during kill:", JSON.stringify(regDuringKill));
    if (regDuringKill.ok) return fail("Registration was allowed while kill switch engaged");

    // Fresh valid ticket registered while the switch is momentarily released,
    // then presented while engaged — must be denied (pending aborted + block).
    killSwitch.release("smoke-reg-window");
    const reg5 = authority.registerPendingCall({ callId: "smoke-5", toolName: "getSystemTime", args: { probe: 5 }, sessionId: "smoke-local-0001" });
    if (!reg5.ok) return fail("authority registration 5 failed: " + reg5.reason);
    killSwitch.engage("smoke-hotkey-again");
    const killedExec = authority.handleExecuteTool({ ticket: reg5.ticket, name: "getSystemTime", args: { probe: 5 } });
    console.log("[smoke] execute while killed:", JSON.stringify(killedExec));
    if (killedExec?.status !== "denied" || killedExec?.reason !== "killSwitchActive") {
      return fail("Kill switch did not block execution of a valid ticket");
    }
    killSwitch.release("smoke");
    updateTray();

    // ---- E. Summary --------------------------------------------------------
    console.log("[smoke] authority stats:", JSON.stringify(authority.stats()));
    console.log("[smoke] audit events captured:", auditLog.recent().length);
    console.log("[smoke] ALL T5.0 + PHASE-B/B.1 CHECKS PASSED — shutting down cleanly...");
    setTimeout(() => app.quit(), 1500);
  } catch (err) {
    return fail("Smoke exception: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#020617",
    title: "Myra AI",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  // Phase C: the app window is part of the trust boundary. A renderer must not
  // be able to spawn a second Electron window, and the app window must never
  // leave the local app origin (otherwise injected content could take over the
  // window the user believes is Myra).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    audit("WINDOW_OPEN_BLOCKED", { reason: "rendererWindowOpen" });
    log("Blocked renderer window.open →", String(url).slice(0, 120));
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === new URL(APP_URL).origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      event.preventDefault();
      audit("NAVIGATION_BLOCKED", { reason: "originMismatch" });
      log("Blocked in-app navigation →", String(url).slice(0, 120));
    }
  });

  const ses = mainWindow.webContents.session;

  // Microphone: allow getUserMedia; everything else falls back to default deny.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    log("Permission request:", permission);
    callback(permission === "media");
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === "media");

  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    log("Renderer gone:", details.reason);
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  log("Loading", APP_URL);
  mainWindow.loadURL(APP_URL).catch((err) => {
    log("loadURL failed, retrying once:", err.message);
    setTimeout(() => mainWindow && mainWindow.loadURL(APP_URL), 2000);
  });

  if (SMOKE) {
    mainWindow.webContents.on("did-finish-load", () => {
      runSmokeChecks();
    });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err) => {
  console.error("[electron-main] Uncaught exception:", err);
});

app.setAppUserModelId("com.myraai.desktop");

app.on("before-quit", () => {
  if (quitting) return;
  quitting = true;
  try {
    globalShortcut.unregisterAll();
  } catch {}
  try {
    pipeServer && pipeServer.close();
  } catch {}
  try {
    // CDP sockets only — the browser window stays open for the user.
    browserControl.dispose();
  } catch {}
  authority.abortPending("appQuit");
  killServerChild();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", killServerChild);
app.on("quit", killServerChild);

app.whenReady().then(async () => {
  log("Electron starting — mode:", PROD_MODE ? "production (in-process server)" : "development (spawned tsx server)");

  try {
    // Trust stack first: the pipe must exist before the server boots so the
    // warmup handshake succeeds in both topologies.
    pipeServer = createHandoffPipeServer({ pipeName: HANDOFF_PIPE, nonce: HANDOFF_NONCE, authority, audit });
    registerIpcHandlers();
    registerKillSurfaces();

    if (PROD_MODE) {
      loadUserEnv();
      const base = app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked");
      process.env.MYRA_DIST_DIR = path.join(base, "dist");
      process.env.NODE_ENV = process.env.NODE_ENV || "production";
      Object.assign(process.env, buildServerEnv());
      // dist/server.cjs self-executes main() on require — boots the server.
      require(path.join(PROJECT_ROOT, "dist", "server.cjs"));
    } else {
      startDevServer();
    }

    await waitForServer();
    log("Server healthy at", APP_URL);
    createWindow();
  } catch (err) {
    killServerChild();
    log("Startup failed:", err.message);
    if (!SMOKE) {
      dialog.showErrorBox("Myra AI", "Failed to start the Myra server:\n" + err.message);
    } else {
      console.log("[smoke] FAIL:", err.message);
    }
    app.exit(1);
  }
});
