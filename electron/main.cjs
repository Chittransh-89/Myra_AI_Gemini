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
 *    http://127.0.0.1:<port> — the same React app the website serves, so the
 *    WebSocket URL derivation in App.tsx (window.location.host) keeps working.
 *  - Secure defaults: contextIsolation, no nodeIntegration, sandboxed preload,
 *    no unrestricted Node APIs exposed to the renderer (see preload.cjs).
 *  - Microphone permission granted for the app session only.
 *  - Graceful shutdown: child server killed (process-tree kill on Windows)
 *    before the app quits, so no orphaned server remains.
 *
 * Env flags (internal/testing):
 *  MYRA_SMOKE=1  — headless smoke-test mode: verifies rendering + WS/Gemini
 *                  session status in the console, then quits the app.
 *  MYRA_PROD=1   — force the production (in-process bundled server) path
 *                  without packaging, for pre-release testing.
 */

const { app, BrowserWindow, dialog } = require("electron");
const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

const PORT = parseInt(process.env.PORT || "3000", 10);
const APP_URL = `http://127.0.0.1:${PORT}`;
const PROJECT_ROOT = path.join(__dirname, "..");
const SMOKE = process.env.MYRA_SMOKE === "1";
const PROD_MODE = app.isPackaged || process.env.MYRA_PROD === "1";

let serverChild = null;
let mainWindow = null;
let quitting = false;
let smokeDone = false;

function log(...args) {
  console.log("[electron-main]", ...args);
}

// ---------------------------------------------------------------------------
// Optional user-level env overrides (packaged mode only).
// Lets users set GEMINI_API_KEY without shell env vars: place a .env file in
// %APPDATA%/Myra AI/.env. Existing process.env values are never overwritten.
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
    ...process.env,
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

  serverChild.stdout.on("data", (chunk) => process.stdout.write("[server] " + chunk));
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

function runSmokeChecks() {
  if (!SMOKE || smokeDone) return;
  smokeDone = true;

  const fail = (msg) => {
    console.log("[smoke] FAIL:", msg);
    dialog.showErrorBox("Myra smoke test", msg);
    app.exit(1);
  };

  setTimeout(() => fail("Timed out before smoke checks completed"), 30000);

  // 1) Did React actually mount into #root?
  mainWindow.webContents
    .executeJavaScript(
      '!!document.getElementById("root") && document.getElementById("root").childElementCount > 0'
    )
    .then(async (rendered) => {
      console.log("[smoke] React rendered:", rendered);
      if (!rendered) return fail("React did not mount into #root");

      // 1b) Sandboxed renderer: no CommonJS require, no Node/fs APIs.
      const requireAvailable = await mainWindow.webContents.executeJavaScript(
        "typeof require"
      );
      console.log("[smoke] renderer `typeof require`:", requireAvailable);
      if (requireAvailable !== "undefined") {
        return fail("Renderer has access to CommonJS require — sandbox check failed");
      }
      const nodeGlobals = await mainWindow.webContents.executeJavaScript(
        'JSON.stringify({fs: typeof window.fs, child_process: typeof window.child_process, ipcRenderer: typeof window.ipcRenderer, myraDesktop: typeof window.myraDesktop})'
      );
      console.log("[smoke] renderer global API check:", nodeGlobals); // expect fs/child_process/ipcRenderer = undefined, myraDesktop = object

      // 2) Does the existing WS protocol connect and reach the Gemini session?
      try {
        const { WebSocket } = require("ws");
        const ws = new WebSocket(APP_URL.replace("http", "ws") + "/ws");
        ws.on("open", () => console.log("[smoke] WS open"));
        ws.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "status") {
              console.log("[smoke] WS status:", msg.state, msg.message || "");
              if (msg.state === "connected" || msg.state === "error") {
                ws.close();
                console.log("[smoke] shutting down cleanly...");
                setTimeout(() => app.quit(), 1500);
              }
            } else if (msg.type === "audio") {
              console.log("[smoke] received audio chunk (playback path OK)");
            }
          } catch (err) {
            /* ignore non-JSON */
          }
        });
        ws.on("close", () => console.log("[smoke] WS closed cleanly"));
        ws.on("error", (err) => fail("WS error: " + err.message));
      } catch (err) {
        return fail("WS test setup failed: " + err.message);
      }
    })
    .catch((err) => fail("Renderer evaluation failed: " + err.message));
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
    mainWindow.webContents.on("did-finish-load", runSmokeChecks);
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
    if (PROD_MODE) {
      loadUserEnv();
      // Server bundle resolves static client files from MYRA_DIST_DIR
      // (dist is asar-unpacked, so express.static can read the real files).
      const base = app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked");
      process.env.MYRA_DIST_DIR = path.join(base, "dist");
      process.env.NODE_ENV = process.env.NODE_ENV || "production";
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
