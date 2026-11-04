"use strict";

/**
 * Myra AI — Browser & YouTube control (Electron MAIN process only).
 *
 * Security model (why this file is safe to hand to the main process):
 *  - Myra drives a DEDICATED Chromium profile (userData/myra-browser-profile).
 *    The user's normal Chrome/Brave/Edge profile — its cookies, sessions and
 *    saved passwords — is never touched or read.
 *  - The DevTools endpoint is Chrome's `--remote-debugging-port`, which binds
 *    to 127.0.0.1 only. It is NOT exposed to the LAN and is never proxied.
 *    No renderer code can reach it: only the main process opens the CDP socket.
 *  - Every navigation goes through validateNavigationUrl(): http/https only,
 *    no embedded credentials, no loopback/private/link-local hosts.
 *  - The window is a normal, visible browser window. Nothing runs headless and
 *    nothing is injected into the user's own browsing session.
 *  - Results are plain JSON (no page objects, no DOM handles, no cookies).
 *
 * The controller never throws at the caller: every action resolves to
 * { ok: true, ... } or { ok: false, error: "<reason>" } so Myra can SPEAK the
 * failure instead of going silent.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { WebSocket } = require("ws");

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_URL_LENGTH = 2048;
const CDP_CALL_TIMEOUT_MS = 15000;
const NAV_READY_TIMEOUT_MS = 20000;
const RESULTS_TIMEOUT_MS = 12000;
const WATCH_TIMEOUT_MS = 15000;
const LAUNCH_TIMEOUT_MS = 25000;
const DEFAULT_SCROLL_PX = 700;
const MAX_SCROLL_PX = 4000;
const MAX_RESULTS = 10;
const MAX_TITLE_LEN = 140;
const MAX_CHANNEL_LEN = 60;
const MAX_QUERY_LEN = 200;
const YT_SEARCH_PREFIX = "https://www.youtube.com/results?search_query=";

const BROWSER_ACTIONS = new Set([
  "open",
  "search",
  "listVideos",
  "clickVideo",
  "scroll",
  "playPause",
  "back",
  "closeTab",
  "close",
  "maximize",
  "minimize",
  "restore",
]);

// A user says "close the browser"; the model may emit any of these. All of them
// mean: close Myra's own browser WINDOW (not just a tab).
const CLOSE_WINDOW_ACTIONS = new Set(["close", "closeBrowser", "closeWindow", "quit"]);

// Spelling/phrasing variants that mean the same window action.
const WINDOW_ACTION_ALIASES = new Map([
  ["maximise", "maximize"],
  ["minimise", "minimize"],
  ["unmaximize", "restore"],
  ["unminimize", "restore"],
  ["normal", "restore"],
  ["restoreWindow", "restore"],
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clampNumber(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

function capText(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// ---------------------------------------------------------------------------
// URL policy (shared by browserControl and openWebsite)
// ---------------------------------------------------------------------------

function isPrivateOrLoopbackHost(hostname) {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  // IPv6 literals (what remains after bracket stripping)
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) return true;
    return false;
  }

  return false;
}

/**
 * Validate + normalise a user/model supplied URL.
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
function validateNavigationUrl(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "urlNotString" };
  let text = raw.trim();
  if (!text) return { ok: false, reason: "emptyUrl" };
  if (text.length > MAX_URL_LENGTH) return { ok: false, reason: "urlTooLong" };

  // Bare hosts ("youtube.com") get https; anything with a scheme is parsed as-is
  // so that javascript:/file:/data: are rejected rather than silently prefixed.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = "https://" + text;

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, reason: "malformedUrl" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "schemeNotAllowed" };
  }
  if (parsed.username || parsed.password) return { ok: false, reason: "credentialsInUrl" };
  if (!parsed.hostname) return { ok: false, reason: "missingHost" };
  if (isPrivateOrLoopbackHost(parsed.hostname)) return { ok: false, reason: "privateHostBlocked" };

  return { ok: true, url: parsed.href };
}

// ---------------------------------------------------------------------------
// Chromium discovery / launch
// ---------------------------------------------------------------------------

function candidateBrowsers() {
  const list = [];
  const add = (exe, name) => {
    if (exe) list.push({ path: exe, name });
  };

  if (process.env.MYRA_BROWSER_PATH) add(process.env.MYRA_BROWSER_PATH, "custom");

  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const lad = process.env.LOCALAPPDATA || "";

    // Brave first (user's stated preference), then Chrome, then Edge.
    add(path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"), "brave");
    if (lad) add(path.join(lad, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"), "brave");
    add(path.join(pf, "Google", "Chrome", "Application", "chrome.exe"), "chrome");
    add(path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"), "chrome");
    if (lad) add(path.join(lad, "Google", "Chrome", "Application", "chrome.exe"), "chrome");
    add(path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), "edge");
    add(path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"), "edge");
  }

  return list;
}

function findBrowserExecutable() {
  for (const candidate of candidateBrowsers()) {
    try {
      if (fs.existsSync(candidate.path)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function getFreePort() {
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

/** Minimal JSON-over-HTTP helper for the CDP discovery endpoints (loopback only). */
function cdpHttp(port, urlPath, method = "GET", timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1024 * 1024) req.destroy();
        });
        res.on("end", () => {
          if (res.statusCode !== 200) return finish(null);
          try {
            finish(JSON.parse(body));
          } catch {
            finish(null);
          }
        });
      }
    );
    req.on("error", () => finish(null));
    req.on("timeout", () => {
      req.destroy();
      finish(null);
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Minimal Chrome DevTools Protocol client (one page target)
// ---------------------------------------------------------------------------

class CdpPage {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id === undefined) return; // events are not needed
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(String(msg.error.message || "cdpError")));
      else entry.resolve(msg.result);
    });

    ws.on("close", () => {
      this.closed = true;
      this.failAll("cdpClosed");
    });
    ws.on("error", () => {
      this.closed = true;
      this.failAll("cdpError");
    });
  }

  failAll(reason) {
    for (const [, entry] of this.pending) entry.reject(new Error(reason));
    this.pending.clear();
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("cdpClosed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("cdpTimeout:" + method));
      }, CDP_CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Evaluate in the page. `userGesture: true` marks the evaluation as a real
   * user activation, which is what makes media playback and click handlers
   * behave exactly as they would for a human click.
   */
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res && res.exceptionDetails) {
      throw new Error("evaluateFailed:" + String(res.exceptionDetails.text || ""));
    }
    return res && res.result ? res.result.value : undefined;
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Send ONE CDP command over a short-lived socket and wait for the reply — or for
 * the socket to close, which is the normal outcome of Browser.close/Page.close.
 * Resolves true when the command was accepted.
 */
function sendBrowserCommand(wsUrl, method, params = {}, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (typeof wsUrl !== "string" || !wsUrl) return resolve(false);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let ws;
    try {
      ws = new WebSocket(wsUrl, { perMessageDeflate: false, handshakeTimeout: 5000 });
    } catch {
      return finish(false);
    }

    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      finish(false);
    }, timeoutMs);

    ws.once("open", () => {
      try {
        ws.send(JSON.stringify({ id: 1, method, params }));
      } catch {
        clearTimeout(timer);
        finish(false);
      }
    });
    ws.once("message", (data) => {
      // A CDP error reply means the browser REFUSED the command. Reporting that
      // as success was exactly how "closed: true" could be a lie.
      let accepted = true;
      try {
        const msg = JSON.parse(data.toString());
        if (msg && msg.error) {
          accepted = false;
        }
      } catch {
        /* unparseable reply — fall through */
      }
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      finish(accepted);
    });
    // The browser/target closing while it processes the command HAS done what
    // was asked — treat that close as success, not as an error.
    ws.once("close", () => {
      clearTimeout(timer);
      finish(true);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Request/response CDP command over a short-lived socket. Unlike
 * sendBrowserCommand (fire-and-forget, used for closing), this returns the reply
 * so a window state can be READ and the result of a change VERIFIED.
 * @returns {Promise<{ok: true, result: object} | {ok: false, error: string}>}
 */
function runBrowserCommand(wsUrl, method, params = {}, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (typeof wsUrl !== "string" || !wsUrl) return resolve({ ok: false, error: "noEndpoint" });

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let ws;
    try {
      ws = new WebSocket(wsUrl, { perMessageDeflate: false, handshakeTimeout: 5000 });
    } catch {
      return finish({ ok: false, error: "connectFailed" });
    }

    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: "timeout" });
    }, timeoutMs);

    ws.once("open", () => {
      try {
        ws.send(JSON.stringify({ id: 1, method, params }));
      } catch {
        clearTimeout(timer);
        finish({ ok: false, error: "sendFailed" });
      }
    });
    ws.once("message", (data) => {
      let result = null;
      let error = null;
      try {
        const msg = JSON.parse(data.toString());
        if (msg && msg.error) error = String(msg.error.message || "cdpError");
        else result = (msg && msg.result) || {};
      } catch {
        error = "badReply";
      }
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      finish(error ? { ok: false, error } : { ok: true, result });
    });
    ws.once("close", () => {
      clearTimeout(timer);
      finish({ ok: false, error: "socketClosed" });
    });
    ws.once("error", () => {
      clearTimeout(timer);
      finish({ ok: false, error: "socketError" });
    });
  });
}

function openCdpPage(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      perMessageDeflate: false,
      maxPayload: 8 * 1024 * 1024,
      handshakeTimeout: 6000,
    });
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    ws.once("open", () => settle(resolve, new CdpPage(ws)));
    ws.once("error", () => settle(reject, new Error("cdpConnectFailed")));
    ws.once("close", () => settle(reject, new Error("cdpConnectClosed")));
  });
}

// ---------------------------------------------------------------------------
// In-page scripts
// ---------------------------------------------------------------------------

/**
 * Extracts YouTube search results (title, channel, href) plus the current
 * page title/URL. Falls back to plain watch links for layouts that do not use
 * ytd-video-renderer (shorts shelves, playlists, etc.).
 */
const YT_EXTRACT_JS = `(function () {
  function clean(t) { return String(t || "").replace(/\\s+/g, " ").trim(); }
  // Real video rows only. A loose "any /watch link" fallback was tried and
  // rejected: on a half-rendered page it returns shelf counters ("9 lessons")
  // instection of video titles, which made Myra pick the wrong thing.
  var SELECTORS = [
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-rich-item-renderer"
  ];
  var out = [];
  var seen = {};
  for (var s = 0; s < SELECTORS.length; s++) {
    var nodes = document.querySelectorAll(SELECTORS[s]);
    for (var i = 0; i < nodes.length && out.length < 20; i++) {
      var a = nodes[i].querySelector("a#video-title, a#video-title-link");
      if (!a) continue;
      var href = a.getAttribute("href") || "";
      if (href.indexOf("/watch") !== 0) continue;
      if (seen[href]) continue;
      var title = clean(a.getAttribute("title") || a.textContent || "");
      if (title.length < 4) continue;
      var ch = nodes[i].querySelector("ytd-channel-name a, #channel-name a, .ytd-channel-name a");
      seen[href] = true;
      out.push({ title: title, channel: clean(ch ? ch.textContent : ""), href: href });
    }
  }
  return JSON.stringify({
    url: location.href,
    title: document.title,
    renderers: document.querySelectorAll("ytd-video-renderer").length,
    results: out
  });
})()`;

/** Best-effort click on a YouTube consent interstitial (fresh profiles only). */
const YT_CONSENT_JS = `(function () {
  var bump = document.querySelector("ytd-consent-bump-v2-renderer");
  if (!bump) return "absent";
  var btn = bump.querySelector('button[aria-label*="Accept"], button[aria-label*="accept"]') || bump.querySelector("button");
  if (!btn) return "noButton";
  btn.click();
  return "clicked";
})()`;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

function createBrowserController({ audit, userDataDir, log } = {}) {
  const emit = typeof log === "function" ? log : () => {};
  const record = typeof audit === "function" ? audit : () => {};
  const profileDir = path.join(userDataDir, "myra-browser-profile");
  const statePath = path.join(userDataDir, "myra-browser-state.json");

  let port = null;
  let browserName = null;
  let page = null;
  let pageId = null;
  let launching = null;

  function saveState() {
    try {
      fs.writeFileSync(statePath, JSON.stringify({ port, browserName }), "utf8");
    } catch {
      /* non-fatal */
    }
  }

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (parsed && Number.isInteger(parsed.port)) return parsed;
    } catch {
      /* ignore */
    }
    return null;
  }

  async function portIsAlive(candidate) {
    const version = await cdpHttp(candidate, "/json/version");
    return Boolean(version && version.webSocketDebuggerUrl);
  }

  /** Drop the persisted CDP port so the next action starts a fresh browser. */
  function forgetState() {
    port = null;
    page = null;
    pageId = null;
    try {
      fs.unlinkSync(statePath);
    } catch {
      /* already gone */
    }
  }

  /**
   * Port of an ALREADY RUNNING Myra browser, or null. Never launches anything:
   * "close the browser" must not open one first. Only ports this controller
   * launched or recorded are considered, so a browser window that belongs to
   * the user (never started with a debug port) can never be targeted.
   */
  async function resolveLivePort() {
    if (port && (await portIsAlive(port))) return port;

    const saved = readState();
    if (saved && (await portIsAlive(saved.port))) {
      port = saved.port;
      browserName = saved.browserName || browserName;
      return port;
    }
    return null;
  }

  /**
   * Reuse the running Myra browser when possible (including one launched by a
   * previous Myra run), otherwise start a visible Chromium window with the
   * dedicated Myra profile.
   */
  async function ensureBrowser() {
    if (port && (await portIsAlive(port))) return port;
    port = null;
    page = null;
    pageId = null;

    if (launching) return launching;

    launching = (async () => {
      const saved = readState();
      if (saved && (await portIsAlive(saved.port))) {
        port = saved.port;
        browserName = saved.browserName || null;
        emit("Reusing Myra browser on CDP port", port);
        return port;
      }

      const found = findBrowserExecutable();
      if (!found) throw new Error("noChromiumBrowserFound");

      const freePort = await getFreePort();
      const args = [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${freePort}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
        // The Myra profile is a controlled profile; this lets a voice command
        // start playback without a physical click on the page.
        "--autoplay-policy=no-user-gesture-required",
        "--window-size=1280,900",
        "about:blank",
      ];

      emit("Launching", found.name, "with the Myra profile");
      const child = spawn(found.path, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.on("error", (err) => {
        emit("Browser launch error:", err.message);
      });
      child.unref();

      const startedAt = Date.now();
      while (Date.now() - startedAt < LAUNCH_TIMEOUT_MS) {
        if (await portIsAlive(freePort)) {
          port = freePort;
          browserName = found.name;
          saveState();
          record("BROWSER_LAUNCHED", { tool: found.name });
          return port;
        }
        await sleep(300);
      }
      throw new Error("browserLaunchTimeout");
    })()
      .finally(() => {
        launching = null;
      });

    return launching;
  }

  /** Reuse Myra's active tab; never spawn a new window per command. */
  async function getPage() {
    const activePort = await ensureBrowser();
    if (page && !page.closed) return page;

    page = null;
    const targets = await cdpHttp(activePort, "/json/list");
    const pages = Array.isArray(targets)
      ? targets.filter((t) => t && t.type === "page" && typeof t.webSocketDebuggerUrl === "string")
      : [];

    let target = pageId ? pages.find((t) => t.id === pageId) || null : null;
    if (!target) target = pages.find((t) => /^https?:/i.test(String(t.url || ""))) || pages[0] || null;

    if (!target) {
      const created = await cdpHttp(activePort, "/json/new?url=" + encodeURIComponent("about:blank"), "PUT");
      if (!created || !created.webSocketDebuggerUrl) throw new Error("browserTabUnavailable");
      target = created;
    }

    page = await openCdpPage(target.webSocketDebuggerUrl);
    pageId = target.id || null;
    try {
      await page.send("Page.enable");
      await page.send("Runtime.enable");
    } catch {
      /* non-fatal: both are enabled implicitly on most builds */
    }
    return page;
  }

  async function waitForReady(p, timeoutMs = NAV_READY_TIMEOUT_MS) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const state = await p.evaluate("document.readyState");
        if (state === "complete") return true;
      } catch {
        /* execution context replaced mid-navigation */
      }
      await sleep(250);
    }
    return false;
  }

  async function navigateTo(url) {
    const p = await getPage();
    await p.send("Page.bringToFront").catch(() => {});
    await p.send("Page.navigate", { url });
    await waitForReady(p);
    return p;
  }

  async function readPage(p) {
    const raw = await p.evaluate(YT_EXTRACT_JS);
    let parsed = { url: "", title: "", results: [] };
    try {
      parsed = JSON.parse(String(raw || "{}"));
    } catch {
      /* ignore */
    }
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    return {
      url: capText(parsed.url, MAX_URL_LENGTH),
      title: capText(parsed.title, MAX_TITLE_LEN),
      renderers: Number(parsed.renderers) || 0,
      results: results.slice(0, MAX_RESULTS).map((r) => ({
        title: capText(r.title, MAX_TITLE_LEN),
        channel: capText(r.channel, MAX_CHANNEL_LEN),
        href: capText(r.href, MAX_URL_LENGTH),
      })),
    };
  }

  /** Does the live URL still belong to the search we asked for? */
  function urlMatchesQuery(url, query) {
    if (!query) return true;
    try {
      const raw = String(url).split("search_query=")[1] || "";
      const decoded = decodeURIComponent(raw.split("&")[0].replace(/\+/g, " "));
      return normalizeText(decoded).includes(normalizeText(query));
    } catch {
      return true;
    }
  }

  /**
   * YouTube re-renders results in place (SPA navigation), so "document ready"
   * says nothing about the result list. Wait until the same non-empty list has
   * been observed on consecutive polls, on a page that still matches the query.
   */
  async function waitForResults(p, { timeoutMs = RESULTS_TIMEOUT_MS, query = "" } = {}) {
    const startedAt = Date.now();
    let last = { url: "", title: "", renderers: 0, results: [] };
    let stable = 0;

    while (Date.now() - startedAt < timeoutMs) {
      let snapshot = null;
      try {
        snapshot = await readPage(p);
      } catch {
        snapshot = null; // execution context replaced mid-navigation
      }

      if (
        snapshot &&
        snapshot.renderers > 0 &&
        snapshot.results.length > 0 &&
        urlMatchesQuery(snapshot.url, query)
      ) {
        const unchanged =
          last.results.length === snapshot.results.length &&
          snapshot.results.every((r, i) => r.href === last.results[i].href);
        stable = unchanged ? stable + 1 : 0;
        last = snapshot;
        if (stable >= 1) return snapshot; // two identical consecutive polls
      } else if (snapshot) {
        stable = 0;
        last = snapshot;
      }

      await sleep(350);
    }
    return last;
  }

  function publicResults(snapshot) {
    return snapshot.results.map((r, index) => ({ index, title: r.title, channel: r.channel }));
  }

  // --- title matching -------------------------------------------------------

  const STOPWORDS = new Set([
    "the", "a", "an", "and", "for", "of", "open", "play", "video", "videos",
    "please", "myra", "ka", "ki", "ke", "ko", "me", "mein", "wala", "wali",
    "par", "pe", "se", "kar", "karo", "wala",
  ]);

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097F ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function scoreMatch(query, title) {
    const q = normalizeText(query);
    const t = normalizeText(title);
    if (!q || !t) return 0;
    if (t.includes(q)) return 1;
    const tokens = q.split(" ").filter((w) => w.length > 2 && !STOPWORDS.has(w));
    if (tokens.length === 0) return 0;
    let hits = 0;
    for (const token of tokens) if (t.includes(token)) hits++;
    return hits / tokens.length;
  }

  /**
   * Match against title AND channel. "Apna College Python" is a channel + topic
   * request, not a title: the real result is titled "Python Full Course for
   * Beginners" and only the channel carries the brand the user said.
   */
  function bestMatch(results, query) {
    let best = null;
    let bestScore = 0;
    for (const result of results) {
      const haystack = `${result.title} ${result.channel || ""}`;
      const score = scoreMatch(query, haystack);
      if (score > bestScore) {
        bestScore = score;
        best = result;
      }
    }
    return bestScore >= 0.5 ? { result: best, score: bestScore } : null;
  }

  // --- actions --------------------------------------------------------------

  async function actionOpen(args) {
    const check = validateNavigationUrl(args.url);
    if (!check.ok) return { ok: false, error: check.reason };

    const p = await navigateTo(check.url);
    const snapshot = await readPage(p).catch(() => ({ url: check.url, title: "", results: [] }));
    return { ok: true, action: "open", url: snapshot.url || check.url, title: snapshot.title };
  }

  async function actionSearch(args) {
    const query = capText(args.query, MAX_QUERY_LEN);
    if (!query) return { ok: false, error: "emptyQuery" };

    const p = await navigateTo(YT_SEARCH_PREFIX + encodeURIComponent(query));
    const consent = await p.evaluate(YT_CONSENT_JS).catch(() => "absent");
    if (consent === "clicked") await sleep(1500);

    const snapshot = await waitForResults(p, { query });
    const videos = publicResults(snapshot);
    if (videos.length === 0) {
      return { ok: false, error: "noResultsFound", query, url: snapshot.url };
    }
    return {
      ok: true,
      action: "search",
      query,
      url: snapshot.url,
      count: videos.length,
      results: videos,
    };
  }

  async function actionListVideos() {
    const p = await getPage();
    const snapshot = await readPage(p);
    const videos = publicResults(snapshot);
    return {
      ok: true,
      action: "listVideos",
      url: snapshot.url,
      pageTitle: snapshot.title,
      count: videos.length,
      results: videos,
    };
  }

  async function actionClickVideo(args) {
    const p = await getPage();
    let snapshot = await readPage(p);
    if (snapshot.results.length === 0) snapshot = await waitForResults(p, { timeoutMs: 8000 });

    if (snapshot.results.length === 0) {
      return { ok: false, error: "noResultsOnPage", url: snapshot.url };
    }

    const videos = publicResults(snapshot);
    let chosen = null;

    const explicitIndex = Number.isInteger(args.index) ? args.index : null;
    if (explicitIndex !== null && explicitIndex >= 0 && explicitIndex < snapshot.results.length) {
      chosen = snapshot.results[explicitIndex];
    } else {
      const query = capText(args.query, MAX_QUERY_LEN);
      if (!query) return { ok: false, error: "missingVideoTitle", available: videos };
      const match = bestMatch(snapshot.results, query);
      if (!match) return { ok: false, error: "videoNotFound", query, available: videos };
      chosen = match.result;
    }

    // Try a real in-page click on the result first (keeps YouTube's SPA state),
    // then fall back to a direct navigation if the click did not take effect.
    const clicked = await p
      .evaluate(
        `(function () {
          var href = ${JSON.stringify(chosen.href)};
          var links = document.querySelectorAll(
            "ytd-video-renderer a#video-title, ytd-video-renderer a#video-title-link, ytd-grid-video-renderer a#video-title"
          );
          for (var i = 0; i < links.length; i++) {
            if (links[i].getAttribute("href") === href) { links[i].click(); return "clicked"; }
          }
          return "notFound";
        })()`
      )
      .catch(() => "error");

    if (clicked !== "clicked") {
      const absolute = chosen.href.startsWith("/") ? "https://www.youtube.com" + chosen.href : chosen.href;
      const check = validateNavigationUrl(absolute);
      if (!check.ok) return { ok: false, error: check.reason };
      await p.send("Page.navigate", { url: check.url }).catch(() => {});
    }

    // Wait until the watch page is actually live.
    const startedAt = Date.now();
    let playing = false;
    while (Date.now() - startedAt < WATCH_TIMEOUT_MS) {
      try {
        const probe = await p.evaluate(
          `JSON.stringify({
            onWatch: location.pathname.indexOf("/watch") === 0,
            hasVideo: !!document.querySelector("video"),
            paused: (document.querySelector("video") || {}).paused !== false,
            title: document.title
          })`
        );
        const info = JSON.parse(String(probe || "{}"));
        if (info.onWatch && info.hasVideo) {
          playing = info.paused === false;
          return {
            ok: true,
            action: "clickVideo",
            title: capText(chosen.title, MAX_TITLE_LEN),
            url: capText(await p.evaluate("location.href").catch(() => chosen.href), MAX_URL_LENGTH),
            playing,
          };
        }
      } catch {
        /* navigation in flight */
      }
      await sleep(400);
    }

    return { ok: false, error: "videoDidNotOpen", title: capText(chosen.title, MAX_TITLE_LEN) };
  }

  async function actionScroll(args) {
    const p = await getPage();
    const direction = args.direction === "up" ? "up" : "down";
    const amount = clampNumber(args.amount, 100, MAX_SCROLL_PX, DEFAULT_SCROLL_PX);
    const delta = direction === "up" ? -amount : amount;

    // YouTube does not always scroll the window: depending on layout the
    // results scroll inside an app container. Scroll every plausible scroller
    // and report the movement that ACTUALLY happened.
    const raw = await p.evaluate(
      `(function () {
        var delta = ${delta};
        var els = [
          document.scrollingElement,
          document.documentElement,
          document.body,
          document.querySelector("#page-container"),
          document.querySelector("ytd-app")
        ];
        var moved = 0;
        var seen = [];
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          if (!el || typeof el.scrollTop !== "number") continue;
          // document.scrollingElement and documentElement are the same node in
          // standards mode — scrolling both would move the page twice.
          if (seen.indexOf(el) !== -1) continue;
          seen.push(el);
          var before = el.scrollTop;
          try {
            if (typeof el.scrollBy === "function") el.scrollBy(0, delta);
            else el.scrollTop = before + delta;
          } catch (e) {}
          moved += (el.scrollTop - before);
        }
        var view = document.scrollingElement || document.documentElement;
        return JSON.stringify({
          moved: Math.round(moved),
          windowY: Math.round(view.scrollTop || 0),
          pageHeight: Math.round(view.scrollHeight || 0),
          viewport: Math.round(window.innerHeight || 0)
        });
      })()`
    );
    let info = {};
    try {
      info = JSON.parse(String(raw || "{}"));
    } catch {
      /* ignore */
    }
    const pageHeight = Number(info.pageHeight) || 0;
    const windowY = Number(info.windowY) || 0;
    const viewport = Number(info.viewport) || 0;
    return {
      ok: true,
      action: "scroll",
      direction,
      scrollY: windowY,
      moved: Number(info.moved) || 0,
      atBottom: pageHeight > 0 && pageHeight - windowY - viewport < 300,
    };
  }

  async function actionPlayPause(args) {
    const p = await getPage();
    const wanted = args.state === "play" || args.state === "pause" ? args.state : "toggle";
    // Only the real watch-page player counts. Search pages also contain hover
    // preview <video> elements, and pausing one of those is not "pause the
    // video" from the user's point of view.
    const raw = await p.evaluate(
      `(async function () {
        var onWatch = location.pathname.indexOf("/watch") === 0;
        var v = document.querySelector("#movie_player video");
        if (!v && onWatch) v = document.querySelector("video");
        if (!v) return JSON.stringify({ found: false });
        var wanted = ${JSON.stringify(wanted)};
        try {
          if (wanted === "play" || (wanted === "toggle" && v.paused)) {
            var p = v.play();
            // play() can stay pending forever (autoplay policy / buffering), so
            // it is bounded here instead of hanging the whole tool call.
            if (p && typeof p.then === "function") {
              await Promise.race([
                p.catch(function () {}),
                new Promise(function (resolve) { setTimeout(resolve, 2500); })
              ]);
            }
          } else {
            v.pause();
          }
        } catch (e) {
          return JSON.stringify({ found: true, error: String((e && e.name) || e) });
        }
        return JSON.stringify({
          found: true,
          paused: v.paused,
          currentTime: Math.round(v.currentTime || 0),
          title: document.title
        });
      })()`
    );
    let info = {};
    try {
      info = JSON.parse(String(raw || "{}"));
    } catch {
      /* ignore */
    }
    if (!info.found) return { ok: false, error: "noVideoOnPage" };
    if (info.error) return { ok: false, error: "playbackBlocked", detail: info.error };
    return {
      ok: true,
      action: "playPause",
      state: info.paused ? "paused" : "playing",
      title: capText(info.title, MAX_TITLE_LEN),
    };
  }

  async function actionBack() {
    const p = await getPage();
    await p.evaluate("history.back()").catch(() => {});
    await sleep(800);
    await waitForReady(p, 8000);
    const snapshot = await readPage(p).catch(() => ({ url: "", title: "", results: [] }));
    return { ok: true, action: "back", url: snapshot.url, title: snapshot.title };
  }

  /** Live page targets of Myra's own browser. */
  async function listPageTargets(activePort) {
    const listed = await cdpHttp(activePort, "/json/list");
    if (!Array.isArray(listed)) return [];
    return listed.filter((t) => t && t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
  }

  /**
   * Wait until a target id is really gone. A CDP "success" reply is not proof:
   * the tab must disappear from the live target list (or the browser must exit).
   */
  async function waitForTargetGone(activePort, id, timeoutMs = 4000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const list = await listPageTargets(activePort);
      if (list.length === 0) return true;
      if (!list.some((t) => t.id === id)) return true;
      await sleep(200);
    }
    return false;
  }

  /** Close Myra's CURRENT TAB, resolved from the live target list. */
  async function actionCloseTab() {
    const livePort = await resolveLivePort();
    if (!livePort) {
      forgetState();
      return { ok: true, action: "closeTab", closed: false, note: "browserNotRunning" };
    }

    let targets = [];
    const listed = await cdpHttp(livePort, "/json/list");
    if (Array.isArray(listed)) {
      targets = listed.filter(
        (t) => t && t.type === "page" && typeof t.webSocketDebuggerUrl === "string"
      );
    }
    if (targets.length === 0) {
      forgetState();
      return { ok: true, action: "closeTab", closed: false, note: "noTab" };
    }

    const target =
      (pageId && targets.find((t) => t.id === pageId)) ||
      targets.find((t) => /^https?:/i.test(String(t.url || ""))) ||
      targets[0];

    if (page) {
      page.close();
      page = null;
      pageId = null;
    }

    await sendBrowserCommand(target.webSocketDebuggerUrl, "Page.close");
    let gone = await waitForTargetGone(livePort, target.id, 4000);

    if (!gone) {
      // Fallback: the DevTools HTTP endpoint closes a target by id. Some
      // Chromium builds refuse Page.close over a page socket.
      await cdpHttp(livePort, "/json/close/" + encodeURIComponent(target.id), "GET");
      gone = await waitForTargetGone(livePort, target.id, 4000);
    }

    // Closing the LAST tab closes the window (and the browser) by itself.
    const stillRunning = await portIsAlive(livePort);
    let remainingTabs = 0;
    if (stillRunning) {
      remainingTabs = (await listPageTargets(livePort)).length;
      if (remainingTabs === 0) forgetState();
    } else {
      forgetState();
    }

    return gone
      ? { ok: true, action: "closeTab", closed: true, remainingTabs }
      : { ok: false, error: "tabCloseFailed", remainingTabs };
  }

  /**
   * Close Myra's dedicated browser WINDOW (all of its tabs) using Chromium's own
   * Browser.close over the loopback CDP endpoint this controller owns.
   *
   * NOT process termination: no PID, no taskkill, no image-name matching. The
   * port is only ever one Myra launched or recorded in its own state file, so
   * other personal browser windows are unreachable from here.
   */
  async function closeBrowser() {
    const livePort = await resolveLivePort();
    if (!livePort) {
      forgetState();
      return { ok: true, action: "close", closed: false, note: "browserNotRunning" };
    }

    const version = await cdpHttp(livePort, "/json/version");
    const browserWs = version && version.webSocketDebuggerUrl;
    if (!browserWs) {
      forgetState();
      return { ok: false, error: "browserNotReachable" };
    }

    record("BROWSER_CLOSE_REQUESTED", { tool: browserName || "unknown" });

    // Drop our page socket first so tab teardown cannot race the close.
    if (page) {
      page.close();
      page = null;
      pageId = null;
    }

    await sendBrowserCommand(browserWs, "Browser.close");

    // Confirm it really exited: the debug port only dies with the process.
    const startedAt = Date.now();
    let gone = false;
    while (Date.now() - startedAt < 10000) {
      if (!(await portIsAlive(livePort))) {
        gone = true;
        break;
      }
      await sleep(250);
    }

    forgetState();
    return gone
      ? { ok: true, action: "close", closed: true }
      : { ok: false, error: "browserStillRunning" };
  }

  // --- window state (maximize / minimize / restore) -------------------------

  /**
   * Everything needed to address Myra's window: the browser-level CDP endpoint
   * and one of ITS OWN page targets. Never launches a browser — a window command
   * on a closed browser reports that instead of opening one.
   */
  async function windowContext() {
    const livePort = await resolveLivePort();
    if (!livePort) return { ok: false, error: "browserNotRunning" };

    const version = await cdpHttp(livePort, "/json/version");
    const browserWs = version && version.webSocketDebuggerUrl;
    if (!browserWs) return { ok: false, error: "browserNotReachable" };

    const targets = await listPageTargets(livePort);
    if (targets.length === 0) return { ok: false, error: "noWindow" };

    const target =
      (pageId && targets.find((t) => t.id === pageId)) ||
      targets.find((t) => /^https?:/i.test(String(t.url || ""))) ||
      targets[0];

    return { ok: true, browserWs, targetId: target.id, port: livePort };
  }

  /** Real window state straight from Chromium ("normal" | "minimized" | "maximized" | "fullscreen"). */
  async function readWindowState(browserWs, targetId) {
    const res = await runBrowserCommand(browserWs, "Browser.getWindowForTarget", { targetId });
    if (!res.ok) return { ok: false, error: res.error };
    const bounds = res.result.bounds || {};
    return {
      ok: true,
      windowId: res.result.windowId,
      state: String(bounds.windowState || "normal"),
    };
  }

  /**
   * Apply a window state to Myra's own window and VERIFY it took effect.
   * "restore" maps to Chromium's "normal", which is also the un-maximize
   * transition. Windows cannot jump minimized -> maximized directly, so that
   * case is normalised through "normal" first.
   */
  async function actionWindowState(wanted) {
    const ctx = await windowContext();
    if (!ctx.ok) return { ok: false, action: wanted, error: ctx.error };

    const current = await readWindowState(ctx.browserWs, ctx.targetId);
    if (!current.ok) return { ok: false, action: wanted, error: current.error };

    // "restore" means: back to a normal, usable size.
    //   minimized -> Windows un-minimises to the size the window had BEFORE it
    //                was minimized (possibly maximized), so both are valid
    //   maximized -> un-maximise to normal
    //   normal    -> already there, nothing to change
    let targetState;
    let accepted;
    if (wanted === "restore") {
      targetState = "normal";
      accepted = current.state === "minimized" ? ["normal", "maximized"] : ["normal"];
    } else {
      targetState = wanted;
      accepted = [targetState];
    }

    if (current.state === "minimized" && targetState === "maximized") {
      // Windows cannot jump minimized -> maximized directly.
      await runBrowserCommand(ctx.browserWs, "Browser.setWindowBounds", {
        windowId: current.windowId,
        bounds: { windowState: "normal" },
      });
      await sleep(250);
    }

    const set = await runBrowserCommand(ctx.browserWs, "Browser.setWindowBounds", {
      windowId: current.windowId,
      bounds: { windowState: targetState },
    });
    if (!set.ok) {
      record("BROWSER_WINDOW_FAILED", { tool: wanted });
      return { ok: false, action: wanted, error: set.error };
    }

    // Bring it forward for maximize/restore (never for minimize).
    if (targetState !== "minimized") {
      await runBrowserCommand(ctx.browserWs, "Target.activateTarget", { targetId: ctx.targetId });
    }

    // Verify — a CDP "ok" reply is not proof the window actually changed.
    let state = current.state;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 3000) {
      const now = await readWindowState(ctx.browserWs, ctx.targetId);
      if (now.ok) {
        state = now.state;
        if (accepted.includes(state)) break;
      }
      await sleep(200);
    }

    record("BROWSER_WINDOW_STATE", { tool: wanted });

    if (accepted.includes(state)) {
      return {
        ok: true,
        action: wanted,
        state: wanted === "restore" ? "restored" : state,
        // Actual state, so an un-minimise that lands maximized is reported
        // accurately instead of being called plain "normal".
        windowState: state,
      };
    }
    return { ok: false, action: wanted, error: "windowStateUnchanged", state };
  }

  // --- public API -----------------------------------------------------------

  async function run(rawArgs) {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    const requested = String(args.action || "").trim();
    const action = CLOSE_WINDOW_ACTIONS.has(requested)
      ? "close"
      : WINDOW_ACTION_ALIASES.get(requested) || requested;

    if (!BROWSER_ACTIONS.has(action)) {
      return { ok: false, error: "unsupportedAction", action: capText(requested, 40) };
    }

    record("BROWSER_ACTION", { tool: action });

    try {
      switch (action) {
        case "open":
          return await actionOpen(args);
        case "search":
          return await actionSearch(args);
        case "listVideos":
          return await actionListVideos();
        case "clickVideo":
          return await actionClickVideo(args);
        case "scroll":
          return await actionScroll(args);
        case "playPause":
          return await actionPlayPause(args);
        case "back":
          return await actionBack();
        case "closeTab":
          return await actionCloseTab();
        case "close":
          return await closeBrowser();
        case "maximize":
          return await actionWindowState("maximized");
        case "minimize":
          return await actionWindowState("minimized");
        case "restore":
          return await actionWindowState("restore");
        default:
          return { ok: false, error: "unsupportedAction" };
      }
    } catch (err) {
      const reason = String((err && err.message) || "browserError");
      record("BROWSER_ACTION_FAILED", { tool: action, reason: reason.slice(0, 60) });
      emit("Browser action failed:", action, reason);
      // A dead CDP socket is recoverable: drop the page so the next call
      // reconnects to the (still running) browser instead of failing forever.
      if (page && page.closed) {
        page = null;
        pageId = null;
      }
      return { ok: false, error: reason.split(":")[0] };
    }
  }

  /** Convenience wrapper used by the existing openWebsite tool. */
  async function open(url) {
    return run({ action: "open", url });
  }

  return {
    open,
    run,
    /** Close CDP sockets only — the browser window belongs to the user. */
    dispose() {
      if (page) {
        page.close();
        page = null;
        pageId = null;
      }
    },
    status() {
      return { port, browserName };
    },
  };
}

module.exports = {
  createBrowserController,
  validateNavigationUrl,
  isPrivateOrLoopbackHost,
  BROWSER_ACTIONS,
  CLOSE_WINDOW_ACTIONS,
};
