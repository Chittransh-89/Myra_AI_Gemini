/**
 * Browser window state awareness regression suite.
 *
 * Uses a REAL controller instance against a fake CDP endpoint (HTTP discovery +
 * browser/page WebSockets), so the production window code path is exercised:
 *   - Browser.getWindowForTarget / Browser.setWindowBounds / Target.activateTarget
 *   - actionWindowState verification, unchanged detection and normalisation
 *   - fullscreen persistence: YouTube actions never touch window bounds
 *   - browser fullscreen vs YouTube video fullscreen stay separate
 *   - windowState pre-application runs the action inside the requested state
 *
 * Run with: node test/browserWindowState.test.cjs
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { WebSocketServer } = require("ws");

// Never let a test failure launch a real Chromium window.
const childProcess = require("child_process");
const realSpawn = childProcess.spawn;
let spawnCalls = 0;
childProcess.spawn = (...args) => {
  spawnCalls += 1;
  const fake = new EventEmitter();
  fake.pid = 4242;
  fake.unref = () => {};
  fake.kill = () => true;
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  return fake;
};

const {
  createBrowserController,
  normalizeWindowStateArg,
  resolveBrowserAction,
  BROWSER_ACTIONS,
} = require("../electron/lib/browserControl.cjs");

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const YT_RESULTS = [
  { title: "Python Full Course for Beginners", channel: "Apna College", href: "/watch?v=abc123" },
  { title: "Python Tutorial", channel: "Other Channel", href: "/watch?v=def456" },
];

function fakeCdpServer() {
  const state = {
    windowState: "normal",
    pageFullscreen: false,
    setWindowBoundsCalls: 0,
    activateCalls: 0,
    newTabRequests: 0,
    navigations: [],
    url: "https://www.youtube.com/",
  };

  let port = 0;

  const evaluate = (expression) => {
    const src = String(expression || "");
    if (src.trim() === "!!document.fullscreenElement") return state.pageFullscreen === true;
    if (src.includes("document.readyState")) return "complete";
    if (src.includes("ytd-consent-bump-v2-renderer")) return "absent";
    if (src.includes("pickVideo")) {
      const entering = src.includes('var op = "fullscreen"');
      const exiting = src.includes('var op = "exitFullscreen"');
      const wantsPause = src.includes('var wanted = "pause"');
      const wantsPlay = src.includes('var wanted = "play"');
      // Real Chromium: HTML fullscreen also reports windowState "fullscreen".
      if (entering) {
        state.pageFullscreen = true;
        state.windowState = "fullscreen";
      }
      if (exiting) {
        state.pageFullscreen = false;
        state.windowState = "normal";
      }
      return JSON.stringify({
        found: true,
        mode: "video",
        adShowing: false,
        title: "Test Video",
        paused: wantsPause ? true : wantsPlay ? false : false,
        muted: false,
        volume: 50,
        currentTime: 10,
        duration: 200,
        fullscreen: entering,
      });
    }
    if (src.includes("ytd-video-renderer")) {
      return JSON.stringify({
        url: state.url,
        title: "YouTube",
        renderers: YT_RESULTS.length,
        results: YT_RESULTS,
      });
    }
    if (src.includes("is-active")) return JSON.stringify({ onShorts: false });
    return undefined;
  };

  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }));
      return;
    }
    if (req.url === "/json/list") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          {
            id: "page1",
            type: "page",
            url: state.url,
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page1`,
          },
        ])
      );
      return;
    }
    if (String(req.url).startsWith("/json/new")) {
      state.newTabRequests += 1;
      res.statusCode = 500;
      res.end("{}");
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.kind = String(req.url).startsWith("/devtools/browser") ? "browser" : "page";
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const reply = (result, error) => {
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify(error ? { id: msg.id, error } : { id: msg.id, result }));
      };

      switch (msg.method) {
        case "Browser.getWindowForTarget":
          return reply({ windowId: 1, bounds: { windowState: state.windowState } });
        case "Browser.setWindowBounds":
          state.setWindowBoundsCalls += 1;
          state.windowState = msg.params && msg.params.bounds ? msg.params.bounds.windowState : state.windowState;
          return reply({});
        case "Target.activateTarget":
          state.activateCalls += 1;
          return reply({});
        case "Page.navigate":
          state.navigations.push(msg.params.url);
          state.url = msg.params.url;
          return reply({ frameId: "frame1" });
        case "Page.bringToFront":
          return reply({});
        case "Runtime.evaluate":
          return reply({ result: { value: evaluate(msg.params.expression) } });
        default:
          return reply({});
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve({
        port,
        state,
        close: () =>
          new Promise((done) => {
            try {
              for (const client of wss.clients) client.terminate();
            } catch {
              /* ignore */
            }
            wss.close();
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

async function run() {
  // --- Pure resolution rules ---------------------------------------------
  {
    for (const action of ["windowFullscreen", "windowExitFullscreen", "getWindowState"]) {
      check(BROWSER_ACTIONS.has(action), `BROWSER_ACTIONS must include ${action}`);
    }
    check(resolveBrowserAction({ action: "browserfullscreen" }).action === "windowFullscreen", "browserfullscreen alias");
    check(resolveBrowserAction({ action: "windowfullscreen" }).action === "windowFullscreen", "windowfullscreen alias");
    check(
      resolveBrowserAction({ action: "fullscreen", target: "browser" }).action === "windowFullscreen",
      "fullscreen + target browser must mean the window"
    );
    check(
      resolveBrowserAction({ action: "fullscreen" }).action === "fullscreen",
      "bare fullscreen keeps its video meaning"
    );
    check(
      resolveBrowserAction({ action: "exitFullscreen", target: "browser" }).action === "windowExitFullscreen",
      "exitFullscreen + target browser must exit the window fullscreen"
    );
    check(resolveBrowserAction({ action: "getwindowstate" }).action === "getWindowState", "getWindowState alias");

    check(normalizeWindowStateArg("fullscreen") === "fullscreen", "fullscreen state arg");
    check(normalizeWindowStateArg("maximized") === "maximized", "maximized state arg");
    check(normalizeWindowStateArg("restore") === "normal", "restore state arg");
    check(normalizeWindowStateArg("windowed") === "normal", "windowed state arg");
    check(normalizeWindowStateArg("bogus") === null, "unknown state arg");

    const serverSource = fs.readFileSync(path.join(__dirname, "..", "src", "server", "index.ts"), "utf8");
    for (const action of ["windowFullscreen", "windowExitFullscreen", "getWindowState"]) {
      check(serverSource.includes(`"${action}"`), `tool schema must declare ${action}`);
    }
    check(/windowState:\s*\{/.test(serverSource), "tool schema must declare the windowState parameter");
    check(/target:\s*\{/.test(serverSource), "tool schema must declare the target parameter");
    check(
      serverSource.includes("Browser fullscreen") || serverSource.includes("browser fullscreen karo"),
      "persona must explain browser fullscreen vs video fullscreen"
    );
  }

  // --- Controller against fake CDP ---------------------------------------
  const cdp = await fakeCdpServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myra-windowstate-"));
  fs.writeFileSync(
    path.join(userDataDir, "myra-browser-state.json"),
    JSON.stringify({ port: cdp.port, browserName: "test-browser" }),
    "utf8"
  );

  const controller = createBrowserController({
    userDataDir,
    audit: () => {},
    log: () => {},
  });

  try {
    // 1. Read the real starting state (never launches).
    const initial = await controller.run({ action: "getWindowState" });
    check(initial.ok === true, "getWindowState must succeed");
    check(initial.windowState === "normal", "browser starts normal");
    check(initial.isNormal === true && initial.isFullscreen === false, "state flags must be accurate");

    // 2. Maximize.
    const maximized = await controller.run({ action: "maximize" });
    check(maximized.ok === true, `maximize must succeed (${maximized.error || ""})`);
    check(maximized.windowState === "maximized", "maximize must report maximized");
    check(cdp.state.setWindowBoundsCalls === 1, "maximize must set bounds exactly once");

    // 3. Repeating maximize must NOT resize again.
    const maximizedAgain = await controller.run({ action: "maximize" });
    check(maximizedAgain.ok === true && maximizedAgain.unchanged === true, "second maximize must be a no-op");
    check(cdp.state.setWindowBoundsCalls === 1, "second maximize must not call setWindowBounds");

    // 4. Browser fullscreen (not video fullscreen).
    const fullscreen = await controller.run({ action: "windowFullscreen" });
    check(fullscreen.ok === true, `windowFullscreen must succeed (${fullscreen.error || ""})`);
    check(fullscreen.windowState === "fullscreen", "window fullscreen must be the real window state");
    check(fullscreen.target === "browser", "window fullscreen must be labelled as the browser window");
    check(cdp.state.setWindowBoundsCalls === 2, "fullscreen must set bounds once");

    // 5. YouTube search runs INSIDE the fullscreen window.
    const search = await controller.run({ action: "search", query: "python" });
    check(search.ok === true, `search must succeed (${search.error || ""})`);
    check(search.count === YT_RESULTS.length, "search must return results");
    check(
      cdp.state.setWindowBoundsCalls === 2,
      "search must NOT change the window state (no restore/resize/reopen)"
    );
    check(cdp.state.newTabRequests === 0, "search must reuse the existing tab");

    // 6. Play/pause and volume inside the same fullscreen window.
    const paused = await controller.run({ action: "playPause", state: "pause" });
    check(paused.ok === true, "pause must succeed in fullscreen");
    check(paused.state === "paused", "pause must report the paused state");
    const resumed = await controller.run({ action: "playPause", state: "play" });
    check(resumed.ok === true, "resume must succeed in fullscreen");
    check(resumed.state === "playing", "resume must report the playing state");
    const volume = await controller.run({ action: "getVolume" });
    check(volume.ok === true && volume.volume === 50, "volume read must succeed in fullscreen");
    check(cdp.state.setWindowBoundsCalls === 2, "playback actions must not touch window bounds");
    check(cdp.state.windowState === "fullscreen", "window must still be fullscreen");
    check(cdp.state.newTabRequests === 0, "no new tab was opened during YouTube actions");

    const stateWhileFullscreen = await controller.run({ action: "getWindowState" });
    check(stateWhileFullscreen.isFullscreen === true, "window state must still read fullscreen");

    // 7. Normal window from fullscreen.
    const normal = await controller.run({ action: "restore" });
    check(normal.ok === true, `restore must succeed (${normal.error || ""})`);
    check(normal.windowState === "normal", "restore must produce a normal window");

    // 8. Video fullscreen must not affect the window.
    const videoIn = await controller.run({ action: "fullscreen" });
    check(videoIn.ok === true, "video fullscreen must succeed");
    check(videoIn.target === "video", "video fullscreen must be labelled as the player");
    check(cdp.state.pageFullscreen === true, "video fullscreen must be DOM fullscreen, not window fullscreen");

    // Chromium reports windowState "fullscreen" for HTML fullscreen too; the
    // controller must still identify it as the PLAYER, not the browser window.
    const windowAfterVideo = await controller.run({ action: "getWindowState" });
    check(windowAfterVideo.windowState === "fullscreen", "HTML fullscreen changes the reported window state");
    check(windowAfterVideo.fullscreenKind === "video", "a fullscreen page element must be identified as video fullscreen");
    check(windowAfterVideo.isPageFullscreen === true, "page fullscreen flag must be true");

    const videoOut = await controller.run({ action: "exitFullscreen" });
    check(videoOut.ok === true && videoOut.target === "video", "exitFullscreen exits the player, not the window");
    check(cdp.state.windowState === "normal", "exiting video fullscreen returns a normal window");

    // 9. "Fullscreen se bahar aao" while the WINDOW is fullscreen exits the window.
    await controller.run({ action: "windowFullscreen" });
    const browserFullscreenState = await controller.run({ action: "getWindowState" });
    check(
      browserFullscreenState.fullscreenKind === "browser",
      "window fullscreen must be identified as browser fullscreen"
    );
    const smartExit = await controller.run({ action: "exitFullscreen" });
    check(smartExit.ok === true, `smart exit must succeed (${smartExit.error || ""})`);
    check(smartExit.target === "browser" && smartExit.mode === "browser", "smart exit must target the browser window");
    check(smartExit.windowState === "normal", "smart exit must return a normal window");

    // 10. windowState pre-application: a YouTube action can request fullscreen first.
    const searchMaximized = await controller.run({
      action: "search",
      query: "python",
      windowState: "maximized",
    });
    check(searchMaximized.ok === true, `search with windowState must succeed (${searchMaximized.error || ""})`);
    check(searchMaximized.windowState === "maximized", "pre-applied windowState must be reported");
    check(cdp.state.windowState === "maximized", "browser must be maximized after the pre-applied state");

    // 11. Maximize is not fullscreen.
    const maxState = await controller.run({ action: "getWindowState" });
    check(maxState.isMaximized === true && maxState.isFullscreen === false, "maximized is distinct from fullscreen");

    check(spawnCalls === 0, "no browser process may be launched by window-state actions");
  } finally {
    controller.dispose();
    await cdp.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  childProcess.spawn = realSpawn;
  console.log("\n==================================================");
  console.log("  ALL BROWSER WINDOW STATE CHECKS PASSED");
  console.log("==================================================");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
