"use strict";

/**
 * YouTube playback controller tests.
 *
 * Part 1 — pure relative-seek / volume math.
 * Part 2 — REAL headless Chromium + CDP, running the EXACT in-page scripts and
 *          the EXACT Shorts stepping routine used by browserControl.cjs against
 *          a YouTube-like fixture (mock HTML5 player + active Shorts reels).
 *
 * Not covered here (and not claimed as verified): a live youtube.com session,
 * the Gemini Live voice pipeline, Brave's own binary and real video decoding.
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { WebSocket } = require("ws");

const {
  computeSeekTarget,
  parseSeekSeconds,
  normalizeVolumeLevel,
  normalizeVolumeStep,
  playerScript,
  shortsStateJs,
  shortsButtonJs,
  driveShortsStep,
  validateNavigationUrl,
  SHORTS_URL,
  BROWSER_ACTIONS,
} = require("../electron/lib/browserControl.cjs");

const FIXTURE = path.join(__dirname, "fixtures", "youtube-player-page.html");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
];

function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function httpJson(port, pathname) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { try { req.destroy(); } catch {} resolve(null); });
    req.end();
  });
}

async function waitUntil(fn, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) return true;
    await sleep(120);
  }
  throw new Error("timeout waiting for " + (label || "condition"));
}

function connectPage(wsUrl, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, handshakeTimeout: 5000 });
    let nextId = 1;
    const pending = new Map();
    let closed = false;

    const session = {
      send(method, params = {}) {
        if (closed) return Promise.reject(new Error("cdpClosed"));
        const id = nextId++;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { pending.delete(id); rej(new Error("cdpTimeout:" + method)); }, timeoutMs);
          pending.set(id, {
            resolve: (v) => { clearTimeout(timer); res(v); },
            reject: (e) => { clearTimeout(timer); rej(e); },
          });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      async evaluate(expression) {
        const res = await session.send("Runtime.evaluate", {
          expression, returnByValue: true, awaitPromise: true, userGesture: true,
        });
        if (res && res.exceptionDetails) throw new Error("pageException");
        return res && res.result ? res.result.value : null;
      },
      close() { closed = true; try { ws.close(); } catch {} },
    };

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id === undefined) return;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(String(msg.error.message || "cdpError")));
      else entry.resolve(msg.result);
    });
    ws.once("open", () => resolve(session));
    ws.once("error", () => reject(new Error("cdpError")));
  });
}

async function runTests() {
  console.log("==================================================");
  console.log("  YOUTUBE PLAYBACK / SHORTS TEST SUITE             ");
  console.log("==================================================");

  // -------------------------------------------------------------------------
  // 1. Relative seek math
  // -------------------------------------------------------------------------
  console.log("\n[TEST 1] Relative seek parsing and clamping...");
  assert.strictEqual(parseSeekSeconds({ seconds: 10 }).seconds, 10);
  assert.strictEqual(parseSeekSeconds({ seconds: -25 }).seconds, -25);
  assert.strictEqual(parseSeekSeconds({ seconds: 90 }).seconds, 90);
  assert.strictEqual(parseSeekSeconds({ seconds: -120 }).seconds, -120);
  assert.strictEqual(parseSeekSeconds({ minutes: 2, direction: "back" }).seconds, -120);
  assert.strictEqual(parseSeekSeconds({ minutes: 1, seconds: 30 }).seconds, 90);
  assert.strictEqual(parseSeekSeconds({ seconds: 25, direction: "forward" }).seconds, 25);
  assert.strictEqual(parseSeekSeconds({ seconds: 25, direction: "back" }).seconds, -25);
  assert.strictEqual(parseSeekSeconds({ seconds: 30, amount: 10 }).seconds, 30);
  assert.strictEqual(parseSeekSeconds({ seconds: 0 }).error, "missingSeekAmount");
  assert.strictEqual(parseSeekSeconds({}).error, "missingSeekAmount");
  assert.strictEqual(parseSeekSeconds({ seconds: 999999 }).error, "seekAmountTooLarge");

  assert.deepStrictEqual(computeSeekTarget(30, 10, 180), {
    from: 30, target: 40, duration: 180, clampedToStart: false, clampedToEnd: false,
  });
  assert.strictEqual(computeSeekTarget(5, -25, 180).target, 0);
  assert.strictEqual(computeSeekTarget(5, -25, 180).clampedToStart, true);
  assert.strictEqual(computeSeekTarget(295, 90, 300).target, 300);
  assert.strictEqual(computeSeekTarget(295, 90, 300).clampedToEnd, true);
  assert.strictEqual(computeSeekTarget(100, -120, NaN).target, 0);
  assert.strictEqual(computeSeekTarget(100, 10, NaN).duration, null);
  assert.strictEqual(computeSeekTarget(0, -1, 0).target, 0);

  assert.strictEqual(normalizeVolumeLevel({ level: 50 }).level, 50);
  assert.strictEqual(normalizeVolumeLevel({ volume: 150 }).level, 100);
  assert.strictEqual(normalizeVolumeLevel({ level: -5 }).level, 0);
  assert.strictEqual(normalizeVolumeLevel({}).error, "missingVolumeLevel");

  assert.strictEqual(normalizeVolumeStep({}), 10);
  assert.strictEqual(normalizeVolumeStep({ step: 15 }), 15);
  assert.strictEqual(normalizeVolumeStep({ step: 0 }), 10);
  assert.strictEqual(normalizeVolumeStep({ step: 250 }), 100);
  assert.strictEqual(normalizeVolumeStep({ step: -5 }), 5);

  assert.strictEqual(validateNavigationUrl(SHORTS_URL).ok, true);
  for (const action of ["openShorts", "nextShort", "previousShort", "seek", "mute", "unmute", "setVolume", "increaseVolume", "decreaseVolume", "getVolume", "fullscreen", "exitFullscreen", "restart"]) {
    assert.ok(BROWSER_ACTIONS.has(action), "BROWSER_ACTIONS must include " + action);
  }
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "src", "server", "index.ts"), "utf8");
  for (const action of ["openShorts", "nextShort", "previousShort", "seek", "setVolume", "increaseVolume", "decreaseVolume", "getVolume", "exitFullscreen"]) {
    assert.ok(serverSource.includes('"' + action + '"'), "tool schema must declare " + action);
  }
  console.log("  ✔ TEST 1 PASSED: signed seconds/minutes, 0/duration clamps, schema wiring");

  // -------------------------------------------------------------------------
  // 2. Real Chromium fixture
  // -------------------------------------------------------------------------
  const browserPath = findBrowser();
  assert.ok(browserPath, "A Chromium browser is required for the player tests");

  const html = fs.readFileSync(FIXTURE, "utf8");
  const httpPort = await freePort();
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve) => httpServer.listen(httpPort, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${httpPort}`;

  const debugPort = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myra-yt-test-"));
  const browserProc = spawn(
    browserPath,
    [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      "--no-default-browser-check", "--disable-background-networking",
      "--autoplay-policy=no-user-gesture-required",
      "--remote-debugging-port=" + debugPort,
      "--user-data-dir=" + userDataDir,
      "--window-size=1000,800",
      base + "/watch?mode=watch",
    ],
    { stdio: "ignore", windowsHide: true }
  );
  browserProc.on("error", () => {});

  let page = null;
  const cleanup = async () => {
    try { if (page) page.close(); } catch {}
    try { browserProc.kill(); } catch {}
    await sleep(400);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    try { httpServer.close(); } catch {}
  };

  try {
    let targets = null;
    await waitUntil(async () => {
      targets = await httpJson(debugPort, "/json/list");
      return Array.isArray(targets) && targets.some((t) => t.type === "page" && String(t.url).startsWith(base));
    }, 20000, "Chromium debug target");

    const target = targets.find((t) => t.type === "page" && String(t.url).startsWith(base));
    page = await connectPage(target.webSocketDebuggerUrl);
    await page.send("Runtime.enable").catch(() => {});
    console.log("  Browser:", path.basename(browserPath), "| CDP port:", debugPort);

    const api = { evaluate: (expr) => page.evaluate(expr), send: (m, p) => page.send(m, p) };
    const evalJson = async (expr) => JSON.parse(String(await page.evaluate(expr) || "{}"));

    async function open(url) {
      await page.send("Page.navigate", { url });
      await waitUntil(async () => (await page.evaluate("window.__fixtureReady === true")) === true, 10000, "fixture ready");
    }
    // The in-page script reports the landed position as currentTime; the
    // controller exposes that same value as toSeconds.
    const seek = async (seconds) => {
      const raw = await evalJson(playerScript("seek", { seconds }));
      return Object.assign({}, raw, { toSeconds: raw.currentTime });
    };

    async function setPosition(value) {
      await page.evaluate(`document.querySelector("video").currentTime = ${Number(value)}`);
    }

    // -----------------------------------------------------------------------
    // 3. Watch-page relative seeking
    // -----------------------------------------------------------------------
    console.log("\n[TEST 2] Watch page: +10s, -25s, +90s (1m30), -120s (2m), clamps...");
    await open(base + "/watch?mode=watch&start=30&duration=180");

    const s1 = await seek(10);
    assert.strictEqual(s1.found, true);
    assert.strictEqual(s1.fromSeconds, 30);
    assert.strictEqual(s1.toSeconds, 40);
    assert.strictEqual(s1.appliedSeconds, 10);
    assert.strictEqual(s1.duration, 180);
    assert.strictEqual(s1.clampedToStart, false);
    assert.strictEqual(s1.clampedToEnd, false);

    const s2 = await seek(-25);
    assert.strictEqual(s2.toSeconds, 15, "25 seconds back from 40 is 15");

    const s3 = await seek(90);
    assert.strictEqual(s3.toSeconds, 105, "1m30 ahead from 15 is 105");

    const s4 = await seek(-120);
    assert.strictEqual(s4.toSeconds, 0, "2 minutes back clamps at 0");
    assert.strictEqual(s4.clampedToStart, true);

    await setPosition(295);
    const s5 = await seek(90);
    assert.strictEqual(s5.toSeconds, 180, "past the end clamps to duration");
    assert.strictEqual(s5.clampedToEnd, true);

    await setPosition(5);
    const s6 = await seek(-25);
    assert.strictEqual(s6.toSeconds, 0);
    assert.strictEqual(s6.clampedToStart, true);
    console.log("  ✔ TEST 2 PASSED: relative seeking never goes below 0 or past duration");

    // -----------------------------------------------------------------------
    // 4. Playback, restart, mute, volume
    // -----------------------------------------------------------------------
    console.log("\n[TEST 3] Play/pause/resume, restart, mute/unmute, volume...");
    await open(base + "/watch?mode=watch&start=50&duration=180");
    const toggle1 = await evalJson(playerScript("playPause", { state: "toggle" }));
    assert.strictEqual(toggle1.paused, false, "toggle from paused starts playback");
    const toggle2 = await evalJson(playerScript("playPause", { state: "toggle" }));
    assert.strictEqual(toggle2.paused, true, "second toggle pauses");
    assert.strictEqual((await evalJson(playerScript("playPause", { state: "play" }))).paused, false);
    assert.strictEqual((await evalJson(playerScript("playPause", { state: "pause" }))).paused, true);

    await setPosition(50);
    const restart = await evalJson(playerScript("restart"));
    assert.strictEqual(restart.currentTime, 0);
    assert.strictEqual(restart.paused, false, "restart starts playing");

    assert.strictEqual((await evalJson(playerScript("mute"))).muted, true);
    assert.strictEqual((await evalJson(playerScript("unmute"))).muted, false);

    const vol50 = await evalJson(playerScript("setVolume", { level: 50 }));
    assert.strictEqual(vol50.volume, 50);
    assert.strictEqual(vol50.muted, false);
    const vol0 = await evalJson(playerScript("setVolume", { level: 0 }));
    assert.strictEqual(vol0.volume, 0);
    assert.strictEqual(vol0.muted, true);
    console.log("  ✔ TEST 3 PASSED: playback, restart, mute and volume verified in the page");

    // -----------------------------------------------------------------------
    // 5. Fullscreen
    // -----------------------------------------------------------------------
    console.log("\n[TEST 4] Fullscreen enter/exit...");
    const fsIn = await evalJson(playerScript("fullscreen"));
    const fsOut = await evalJson(playerScript("exitFullscreen"));
    assert.strictEqual(fsIn.fullscreen, true, "entered fullscreen");
    assert.strictEqual(fsOut.fullscreen, false, "exited fullscreen");
    console.log("  ✔ TEST 4 PASSED: HTML fullscreen toggled and verified");

    // -----------------------------------------------------------------------
    // 6. Ad safety
    // -----------------------------------------------------------------------
    console.log("\n[TEST 5] Ad playing must refuse timeline seeking...");
    await open(base + "/watch?mode=watch&start=10&duration=180&ad=1");
    const ad = await seek(10);
    assert.strictEqual(ad.found, true);
    assert.strictEqual(ad.adShowing, true);
    assert.strictEqual(ad.error, "adPlaying");
    assert.strictEqual(await page.evaluate("document.querySelector('video').currentTime"), 10, "position unchanged during ad");
    console.log("  ✔ TEST 5 PASSED: seeking is refused while an ad is playing");

    // -----------------------------------------------------------------------
    // 7. Shorts seeking targets the active reel only
    // -----------------------------------------------------------------------
    console.log("\n[TEST 6] Shorts: seek applies to the ACTIVE reel only...");
    await open(base + "/shorts/short1?mode=shorts");
    const activeSeek = await seek(15);
    assert.strictEqual(activeSeek.found, true);
    assert.strictEqual(activeSeek.mode, "shorts");
    assert.strictEqual(activeSeek.toSeconds, 15);
    const positions = await page.evaluate(
      "JSON.stringify(Array.from(document.querySelectorAll('ytd-reel-video-renderer video')).map(function (v) { return v.currentTime; }))"
    );
    assert.deepStrictEqual(JSON.parse(positions), [15, 0, 0], "only the active Short moved");
    const shortEnd = await seek(90);
    assert.strictEqual(shortEnd.toSeconds, 60);
    assert.strictEqual(shortEnd.clampedToEnd, true, "clamped to the Short duration");
    console.log("  ✔ TEST 6 PASSED: Shorts seek is relative, active-reel scoped and clamped");

    // -----------------------------------------------------------------------
    // 8. Shorts navigation: wheel, keyboard, button fallbacks
    // -----------------------------------------------------------------------
    console.log("\n[TEST 7] Shorts next/previous via trusted wheel...");
    await open(base + "/shorts/short1?mode=shorts");
    const wheel1 = await driveShortsStep(api, "down");
    assert.strictEqual(wheel1.ok, true, "first step down works: " + JSON.stringify(wheel1));
    assert.strictEqual(wheel1.method, "wheel");
    assert.strictEqual(wheel1.activeId, "short2");
    const wheel2 = await driveShortsStep(api, "down");
    assert.strictEqual(wheel2.activeId, "short3");
    const wheelEnd = await driveShortsStep(api, "down");
    assert.strictEqual(wheelEnd.ok, false, "no next Short at the end");
    assert.strictEqual(wheelEnd.error, "noNextShort");
    const wheelUp = await driveShortsStep(api, "up");
    assert.strictEqual(wheelUp.ok, true);
    assert.strictEqual(wheelUp.activeId, "short2");
    console.log("  ✔ TEST 7 PASSED: next/previous move one reel and the end is reported honestly");

    console.log("\n[TEST 8] Shorts keyboard fallback...");
    await open(base + "/shorts/short1?mode=shorts&wheel=0");
    const keyStep = await driveShortsStep(api, "down");
    assert.strictEqual(keyStep.ok, true);
    assert.strictEqual(keyStep.method, "keyboard", "wheel ignored -> trusted ArrowDown is used");
    assert.strictEqual(keyStep.activeId, "short2");
    console.log("  ✔ TEST 8 PASSED: trusted arrow key advances one Short");

    console.log("\n[TEST 9] Shorts on-screen button fallback...");
    await open(base + "/shorts/short1?mode=shorts&wheel=0&keys=0");
    const btnStep = await driveShortsStep(api, "down");
    assert.strictEqual(btnStep.ok, true);
    assert.strictEqual(btnStep.method, "button");
    assert.strictEqual(btnStep.activeId, "short2");
    const btnUp = await driveShortsStep(api, "up");
    assert.strictEqual(btnUp.ok, true);
    assert.strictEqual(btnUp.activeId, "short1");
    console.log("  ✔ TEST 9 PASSED: navigation button fallback moves both directions");

    // -----------------------------------------------------------------------
    // 9. Missing player
    // -----------------------------------------------------------------------
    console.log("\n[TEST 10] Missing video element...");
    await open(base + "/watch?mode=watch&novideo=1");
    const none = await evalJson(playerScript("state"));
    assert.strictEqual(none.found, false);
    assert.strictEqual(none.error, "noVideoOnPage");
    console.log("  ✔ TEST 10 PASSED: no player reports noVideoOnPage");

    // -----------------------------------------------------------------------
    // 10. Volume: relative steps, clamps, mute/unmute restore, query
    // -----------------------------------------------------------------------
    console.log("\n[TEST 11] Volume increase/decrease/mute/unmute/query...");
    await open(base + "/watch?mode=watch&start=5&duration=180");

    const q0 = await evalJson(playerScript("getVolume"));
    assert.strictEqual(q0.found, true);
    assert.strictEqual(q0.volume, 100);
    assert.strictEqual(q0.muted, false);

    const down1 = await evalJson(playerScript("volumeDelta", { delta: -10 }));
    assert.strictEqual(down1.volume, 90);
    assert.strictEqual(down1.appliedDelta, -10);
    const down2 = await evalJson(playerScript("volumeDelta", { delta: -10 }));
    assert.strictEqual(down2.volume, 80);

    await evalJson(playerScript("setVolume", { level: 5 }));
    const toZero = await evalJson(playerScript("volumeDelta", { delta: -10 }));
    assert.strictEqual(toZero.volume, 0, "never below 0");
    assert.strictEqual(toZero.clampedAtMin, true);
    assert.strictEqual(toZero.muted, true, "0% is silent");

    const up1 = await evalJson(playerScript("volumeDelta", { delta: 10 }));
    assert.strictEqual(up1.volume, 10);
    assert.strictEqual(up1.muted, false, "raising volume unmutes");

    await evalJson(playerScript("setVolume", { level: 100 }));
    const maxed = await evalJson(playerScript("volumeDelta", { delta: 10 }));
    assert.strictEqual(maxed.volume, 100, "never above 100");
    assert.strictEqual(maxed.clampedAtMax, true);
    assert.strictEqual(maxed.appliedDelta, 0);

    const muted = await evalJson(playerScript("mute"));
    assert.strictEqual(muted.muted, true);
    assert.strictEqual(muted.volume, 100, "muting keeps the level");
    const unmuted = await evalJson(playerScript("unmute"));
    assert.strictEqual(unmuted.muted, false);
    assert.strictEqual(unmuted.volume, 100);

    await evalJson(playerScript("setVolume", { level: 50 }));
    await evalJson(playerScript("setVolume", { level: 0 }));
    assert.strictEqual((await evalJson(playerScript("getVolume"))).volume, 0);
    const restored = await evalJson(playerScript("unmute"));
    assert.strictEqual(restored.muted, false);
    assert.strictEqual(restored.volume, 50, "unmute restores the previous audible volume");

    await evalJson(playerScript("playPause", { state: "pause" }));
    const pausedState = await evalJson(playerScript("getVolume"));
    assert.strictEqual(pausedState.paused, true);
    const pausedDown = await evalJson(playerScript("volumeDelta", { delta: -10 }));
    assert.strictEqual(pausedDown.paused, true);
    assert.strictEqual(pausedDown.volume, 40, "volume works while paused");

    await open(base + "/shorts/short1?mode=shorts");
    const shortVol = await evalJson(playerScript("getVolume"));
    assert.strictEqual(shortVol.found, true);
    assert.strictEqual(shortVol.mode, "shorts");
    const shortDown = await evalJson(playerScript("volumeDelta", { delta: -10 }));
    assert.strictEqual(shortDown.volume, 90, "the active Short's own player volume");
    console.log("  ✔ TEST 11 PASSED: relative volume, clamps, mute restore, query, paused and Shorts");

    console.log("\n==================================================");
    console.log("  ALL YOUTUBE CONTROLLER TESTS PASSED             ");
    console.log("==================================================");
  } finally {
    await cleanup();
  }
}

runTests().catch((err) => {
  console.error("\nTEST FAILED:", err && err.stack ? err.stack : err);
  process.exit(1);
});
