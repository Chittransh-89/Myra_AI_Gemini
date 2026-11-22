"use strict";

/**
 * Myra AI — Phase 3 app/window controller tests.
 *
 * Exercises the REAL electron/lib/appControl.cjs against injected OS deps
 * (process list, spawn, taskkill, PowerShell window script, foreground window,
 * window titles, filesystem probes). No real app is launched and no real
 * process is killed.
 *
 * The important assertions are about verification and the security boundary:
 *  - the model can only name allowlisted apps (never paths/executables),
 *  - plain launch never receives model-supplied arguments,
 *  - closing needs a one-time approval and is verified,
 *  - "success" is never reported without observing the outcome.
 */

const assert = require("assert");

const { createAppControl } = require("../electron/lib/appControl.cjs");
const {
  APP_ALLOWLIST,
  APP_BY_KEY,
  expandEnvPath,
} = require("../electron/lib/appCatalog.cjs");

const ENV = {
  LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
  APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  SystemRoot: "C:\\Windows",
};

const TIMEOUTS = {
  launchVerifyMs: 80,
  launchPollMs: 5,
  closeVerifyMs: 100,
  closePollMs: 5,
  windowRetryMs: 5,
  windowSettleMs: 5,
  folderVerifyMs: 80,
  approvalTtlMs: 60000,
  installCacheMs: 0,
};

function exePath(entry) {
  return expandEnvPath((entry.exeCandidates || [])[0], ENV);
}

function createHarness(options = {}) {
  const exists = new Set(options.exists || []);
  const dirs = new Set(options.dirs || []);
  const readDirs = new Map(Object.entries(options.readDirs || {}));
  const procs = new Map(); // image -> Set<pid>
  const titles = new Map(); // image -> window title
  const iconics = new Map();
  const zoomed = new Map();

  const spawns = [];
  const kills = [];
  const scripts = [];
  const audits = [];

  let pidSeq = 6100;
  const spawnQueue = (options.spawnResults || []).slice();
  let activeImage = options.activeImage || null;
  const gracefulKillWorks = options.gracefulKill !== false;

  function addProc(image, pid) {
    const id = pid || ++pidSeq;
    if (!procs.has(image)) procs.set(image, new Set());
    procs.get(image).add(id);
    if (!titles.has(image)) titles.set(image, "");
    return id;
  }
  function removeProc(image, pid) {
    const set = procs.get(image);
    if (set) set.delete(pid);
  }
  function firstPid(image) {
    const set = procs.get(image);
    return set && set.size > 0 ? [...set][0] : null;
  }
  /** The controller passes Get-Process style names ("notepad"); map to the
   *  harness' real image keys ("Notepad.exe"). */
  function resolveImage(name) {
    const wanted = String(name).toLowerCase();
    for (const image of procs.keys()) {
      const lower = image.toLowerCase();
      if (lower === wanted || lower === wanted + ".exe") return image;
    }
    return null;
  }
  function runningImages() {
    return [...procs.entries()].filter(([, pids]) => pids.size > 0).map(([image]) => image);
  }
  function imagesForExe(exe) {
    for (const entry of APP_ALLOWLIST) {
      for (const candidate of entry.exeCandidates || []) {
        if (expandEnvPath(candidate, ENV) === exe) return entry.images;
      }
    }
    return null;
  }

  const deps = {
    pathInfo: (target) => ({
      exists: exists.has(target) || dirs.has(target),
      isDirectory: dirs.has(target),
    }),
    readDirNames: (dir) => readDirs.get(dir) || [],
    listProcesses: async () =>
      [...procs.entries()].flatMap(([name, pids]) => [...pids].map((pid) => ({ name, pid }))),
    spawnDetached: async (exe, args) => {
      spawns.push({ exe, args: [...args] });
      const queued = spawnQueue.shift();
      if (queued) {
        if (queued.ok && Array.isArray(queued.images)) {
          for (const image of queued.images) addProc(image);
        }
        return queued.ok ? { ok: true, pid: ++pidSeq } : queued;
      }
      const images = imagesForExe(exe);
      if (images && options.spawnStarts !== false) addProc(images[0]);
      return { ok: true, pid: ++pidSeq };
    },
    killPid: async (pid, force) => {
      kills.push({ pid, force });
      if (!force && !gracefulKillWorks) return { ok: true };
      for (const [image, set] of procs) if (set.has(pid)) set.delete(pid);
      return { ok: true };
    },
    windows: async (action, images) => {
      const actual = images.map(resolveImage).filter(Boolean);
      scripts.push({ action, images: [...images] });
      if (options.windowScriptOk === false) return { ok: false, windows: [] };
      if (options.windowNoop !== true) {
        for (const image of actual) {
          if (action === "minimize") {
            iconics.set(image, true);
          } else if (action === "maximize") {
            zoomed.set(image, true);
            iconics.set(image, false);
          } else if (action === "restore") {
            iconics.set(image, false);
            zoomed.set(image, false);
          } else if (action === "focus" && options.focusDenied !== true) {
            activeImage = image;
          }
        }
      }
      const present = actual.filter((image) => firstPid(image) !== null);
      return {
        ok: true,
        windows: present.map((image) => ({
          name: image,
          pid: firstPid(image),
          hwnd: 1000,
          iconic: iconics.get(image) === true,
          zoomed: zoomed.get(image) === true,
        })),
      };
    },
    activeWindow: async () => {
      if (!activeImage) return null;
      return {
        pid: firstPid(activeImage) || 999999,
        name: activeImage,
        title: titles.get(activeImage) || "",
      };
    },
    windowTitles: async () =>
      runningImages().map((image) => ({
        name: image,
        pid: firstPid(image),
        title: titles.get(image) || "",
      })),
    openExternal: async (target) => {
      spawns.push({ exe: "openExternal", args: [target] });
      return true;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    now: Date.now,
  };

  const control = createAppControl({
    audit: (event, fields) => audits.push({ event, ...(fields || {}) }),
    log: () => {},
    platform: "win32",
    env: ENV,
    deps,
    timeouts: TIMEOUTS,
  });

  return {
    control,
    deps,
    spawns,
    kills,
    scripts,
    audits,
    addProc,
    removeProc,
    setTitle: (image, title) => titles.set(image, title),
    setActive: (image) => {
      activeImage = image;
    },
    activeImage: () => activeImage,
    runningImages,
  };
}

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✔ " + name);
  } catch (err) {
    failures.push({ name, err });
    console.error("  ✘ " + name);
    console.error("     " + (err && err.message));
  }
}

async function main() {
  console.log("[TEST] Phase 3 app/window control");

  // -- launch ---------------------------------------------------------------

  await check("unknown app name is refused with a reason and suggestions", async () => {
    const h = createHarness();
    const res = await h.control.run({ action: "launch", app: "photoshop" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "appNotInAllowlist");
    assert.ok(Array.isArray(res.suggestions));
    assert.strictEqual(h.spawns.length, 0);
    assert.ok(h.audits.some((event) => event.event === "APP_ACTION"));
  });

  await check("a model-supplied executable path cannot launch that path", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)] });

    // A shell is not on the allowlist at all.
    const cmd = await h.control.run({ action: "launch", app: "C:\\Windows\\System32\\cmd.exe" });
    assert.strictEqual(cmd.ok, false);
    assert.strictEqual(cmd.error, "appNotInAllowlist");
    assert.strictEqual(h.spawns.length, 0);

    // A path that merely CONTAINS an allowlisted name resolves to that APP, and
    // the executable launched is the allowlisted install path — never the path
    // the model supplied.
    const notepadLike = await h.control.run({
      action: "launch",
      app: "D:\\Downloads\\notepad.exe",
    });
    assert.strictEqual(notepadLike.ok, true, JSON.stringify(notepadLike));
    assert.strictEqual(h.spawns.length, 1);
    assert.strictEqual(h.spawns[0].exe, exePath(notepad));
    assert.ok(!h.spawns.some((spawn) => spawn.exe.toLowerCase().startsWith("d:\\")));
  });

  await check("an allowlisted app that is not installed is explained", async () => {
    const h = createHarness();
    const res = await h.control.run({ action: "launch", app: "chrome" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "appNotInstalled");
    assert.ok(res.detail && res.detail.length > 0);
    assert.strictEqual(h.spawns.length, 0);
  });

  await check("installed app launches from its allowlisted path with no arguments", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)] });
    const res = await h.control.run({ action: "launch", app: "notepad", args: ["/evil", "cmd"] });

    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.launched, true);
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.method, "exe");
    assert.strictEqual(h.spawns.length, 1);
    assert.strictEqual(h.spawns[0].exe, exePath(notepad));
    assert.deepStrictEqual(h.spawns[0].args, [], "plain launch must never accept model arguments");
    assert.ok(h.audits.some((event) => event.event === "APP_LAUNCHED" && event.app === "notepad"));
  });

  await check("an already running app is brought to the front, not launched twice", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)] });
    h.addProc("Notepad.exe");
    const res = await h.control.run({ action: "launch", app: "notepad" });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.alreadyRunning, true);
    assert.strictEqual(res.launched, false);
    assert.strictEqual(res.focused, true);
    assert.strictEqual(h.spawns.length, 0);
    assert.strictEqual(h.activeImage(), "Notepad.exe");
  });

  await check("a launch that cannot be verified is reported as unverified", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)], spawnStarts: false });
    const res = await h.control.run({ action: "launch", app: "notepad" });

    assert.strictEqual(res.ok, false, "must not claim success without observing the process");
    assert.strictEqual(res.error, "launchUnverified");
    assert.strictEqual(res.launched, true, "the attempt is still reported honestly");
    assert.ok(h.audits.some((event) => event.event === "APP_LAUNCH_UNVERIFIED"));
  });

  await check("a missing primary exe falls back to the allowlisted UWP target once", async () => {
    const calculator = APP_BY_KEY.get("calculator");
    const h = createHarness({
      exists: [exePath(calculator)],
      spawnResults: [
        { ok: false, error: "exeNotFound" },
        { ok: true, images: ["CalculatorApp.exe"] },
      ],
    });
    const res = await h.control.run({ action: "launch", app: "calculator" });

    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.method, "uwp");
    assert.strictEqual(h.spawns.length, 2);
    assert.strictEqual(h.spawns[1].exe, expandEnvPath("%SystemRoot%\\explorer.exe", ENV));
    assert.ok(String(h.spawns[1].args[0]).startsWith("shell:AppsFolder\\Microsoft.WindowsCalculator"));
    assert.ok(h.audits.some((event) => event.event === "APP_LAUNCH_FAILED"));
  });

  // -- close ---------------------------------------------------------------

  await check("close needs a one-time approval before anything is killed", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)] });
    h.addProc("Notepad.exe");

    const prepared = await h.control.run({ action: "close", app: "notepad" });
    assert.strictEqual(prepared.ok, false);
    assert.strictEqual(prepared.error, "confirmationRequired");
    assert.strictEqual(prepared.requiresConfirmation, true);
    assert.ok(/^[a-f0-9]{32}$/.test(prepared.approvalId));
    assert.strictEqual(h.kills.length, 0, "nothing may be killed before confirmation");

    const closed = await h.control.run({
      action: "close",
      app: "notepad",
      approvalId: prepared.approvalId,
    });
    assert.strictEqual(closed.ok, true, JSON.stringify(closed));
    assert.strictEqual(closed.closed, true);
    assert.strictEqual(closed.forced, false);
    assert.strictEqual(h.kills.length, 1);
    assert.strictEqual(h.kills[0].force, false, "graceful close first");
    assert.ok(h.audits.some((event) => event.event === "APP_CLOSED" && event.app === "notepad"));
  });

  await check("an approval cannot be reused, and a forged one is rejected", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)] });
    h.addProc("Notepad.exe");

    const prepared = await h.control.run({ action: "close", app: "notepad" });
    const approvalId = prepared.approvalId;

    const forged = await h.control.run({ action: "close", app: "notepad", approvalId: "f".repeat(32) });
    assert.strictEqual(forged.error, "invalidApproval");

    const closed = await h.control.run({ action: "close", app: "notepad", approvalId });
    assert.strictEqual(closed.ok, true);

    h.addProc("Notepad.exe"); // same app running again
    const reused = await h.control.run({ action: "close", app: "notepad", approvalId });
    assert.strictEqual(reused.ok, false);
    assert.strictEqual(reused.error, "invalidApproval");
    assert.ok(h.audits.some((event) => event.event === "APP_CLOSE_DENIED"));
  });

  await check("File Explorer is never closed, even when it is in front", async () => {
    const explorer = APP_BY_KEY.get("fileexplorer");
    const h = createHarness({ exists: [exePath(explorer)], activeImage: "explorer.exe" });
    h.addProc("explorer.exe");
    const res = await h.control.run({ action: "close", app: "this" });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "closeNotPermitted");
    assert.strictEqual(h.kills.length, 0);
  });

  await check("closing an app that is not running is an explicit no-op failure", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)] });
    const res = await h.control.run({ action: "close", app: "notepad" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "notRunning");
    assert.strictEqual(h.kills.length, 0);
  });

  await check("a graceful close that does not work escalates to a forced kill", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)], gracefulKill: false });
    h.addProc("Notepad.exe");

    const prepared = await h.control.run({ action: "close", app: "notepad" });
    const closed = await h.control.run({
      action: "close",
      app: "notepad",
      approvalId: prepared.approvalId,
    });

    assert.strictEqual(closed.ok, true, JSON.stringify(closed));
    assert.strictEqual(closed.forced, true);
    assert.ok(h.kills.some((kill) => kill.force === true));
  });

  // -- windows -------------------------------------------------------------

  await check("minimize is verified through the real window state", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)] });
    h.addProc("Notepad.exe");

    const res = await h.control.run({ action: "minimize", app: "notepad" });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.state, "minimized");
    assert.deepStrictEqual(h.scripts[0].images, ["notepad"], "images are normalised, never paths");
  });

  await check("maximize and restore are verified", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)] });
    h.addProc("Notepad.exe");

    const max = await h.control.run({ action: "maximize", app: "notepad" });
    assert.strictEqual(max.ok, true);
    assert.strictEqual(max.state, "maximized");

    const restore = await h.control.run({ action: "restore", app: "notepad" });
    assert.strictEqual(restore.ok, true);
    assert.strictEqual(restore.state, "normal");
  });

  await check("a window command that Windows ignores is retried once, then fails", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)], windowNoop: true });
    h.addProc("Notepad.exe");

    const res = await h.control.run({ action: "maximize", app: "notepad" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "windowStateUnchanged");
    assert.strictEqual(h.scripts.length, 2, "exactly one retry, never a loop");
  });

  await check("window actions on a stopped app do not run a script", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)] });
    const res = await h.control.run({ action: "minimize", app: "notepad" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "notRunning");
    assert.strictEqual(h.scripts.length, 0);
  });

  await check("focus is verified by the foreground process", async () => {
    const chrome = APP_BY_KEY.get("chrome");
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({
      exists: [exePath(chrome), exePath(notepad)],
      activeImage: "Notepad.exe",
    });
    h.addProc("Notepad.exe");
    h.addProc("chrome.exe");

    const res = await h.control.run({ action: "focus", app: "chrome" });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.verified, true);
    assert.strictEqual(h.activeImage(), "chrome.exe");
  });

  await check("focus denied by Windows is reported, not faked", async () => {
    const chrome = APP_BY_KEY.get("chrome");
    const h = createHarness({ exists: [exePath(chrome)], focusDenied: true });
    h.addProc("chrome.exe");
    h.setActive("chrome.exe");

    const res = await h.control.run({ action: "focus", app: "chrome" });
    // Foreground is already chrome, so this one legitimately succeeds.
    assert.strictEqual(res.ok, true);

    h.setActive("Notepad.exe");
    h.addProc("Notepad.exe");
    const blocked = await h.control.run({ action: "focus", app: "chrome" });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.error, "focusBlocked");
    assert.strictEqual(h.scripts.filter((script) => script.action === "focus").length >= 2, true);
  });

  await check("cycle switches to the next running manage app", async () => {
    const chrome = APP_BY_KEY.get("chrome");
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({
      exists: [exePath(chrome), exePath(notepad)],
      activeImage: "Notepad.exe",
    });
    h.addProc("Notepad.exe");
    h.addProc("chrome.exe");

    const res = await h.control.run({ action: "cycle" });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.ok(["chrome", "notepad"].includes(res.app.key));
    assert.ok(Array.isArray(res.candidates) && res.candidates.length === 2);
  });

  // -- context / follow-ups -------------------------------------------------

  await check('"this" resolves the real foreground app', async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)] });
    h.addProc("Notepad.exe");
    h.setActive("Notepad.exe");

    const res = await h.control.run({ action: "minimize", app: "this" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.app.key, "notepad");
  });

  await check("an unmanageable foreground app is explained, never guessed", async () => {
    const h = createHarness({ activeImage: "electron.exe" });
    h.addProc("electron.exe");
    const res = await h.control.run({ action: "minimize" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "activeAppNotManageable");
    assert.strictEqual(h.scripts.length, 0);
  });

  await check('"previous" resolves the last app Myra used', async () => {
    const chrome = APP_BY_KEY.get("chrome");
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(chrome), exePath(notepad)] });

    h.addProc("Notepad.exe");
    const launched = await h.control.run({ action: "launch", app: "notepad" });
    assert.strictEqual(launched.ok, true);

    h.addProc("chrome.exe");
    h.setActive("chrome.exe");

    const res = await h.control.run({ action: "focus", app: "pichla" });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.app.key, "notepad");
  });

  await check("a bare 'browser' is ambiguous when several are installed", async () => {
    const chrome = APP_BY_KEY.get("chrome");
    const edge = APP_BY_KEY.get("edge");
    const h = createHarness({ exists: [exePath(chrome), exePath(edge)] });

    const res = await h.control.run({ action: "launch", app: "browser" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "ambiguousApp");
    assert.strictEqual(res.candidates.length, 2);
    assert.strictEqual(h.spawns.length, 0);
  });

  await check("a bare 'browser' resolves when exactly one is installed", async () => {
    const chrome = APP_BY_KEY.get("chrome");
    const h = createHarness({ exists: [exePath(chrome)] });
    const res = await h.control.run({ action: "launch", app: "browser" });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.app.key, "chrome");
  });

  await check("list only reports allowlisted apps and the active one", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)], activeImage: "Notepad.exe" });
    h.addProc("Notepad.exe");
    h.addProc("electron.exe");
    h.addProc("svchost.exe");

    const res = await h.control.run({ action: "list" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.count, 1);
    assert.strictEqual(res.apps[0].key, "notepad");
    assert.strictEqual(res.active.key, "notepad");
    assert.ok(!res.apps.some((app) => app.key === "electron"));
  });

  await check("installed reports the real installation state", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const chrome = APP_BY_KEY.get("chrome");
    const h = createHarness({ exists: [exePath(notepad), exePath(chrome)] });

    const res = await h.control.run({ action: "installed" });
    assert.strictEqual(res.ok, true);
    const installedKeys = res.apps.filter((app) => app.installed).map((app) => app.key);
    assert.ok(installedKeys.includes("chrome"), "chrome should be reported installed");
    assert.ok(installedKeys.includes("notepad"), "notepad should be reported installed");
    assert.ok(installedKeys.includes("settings"), "built-in Settings is always available");
    assert.ok(!installedKeys.includes("word"), "Word is not installed in this harness");
    assert.strictEqual(res.installedCount, installedKeys.length);
    assert.strictEqual(res.count, APP_ALLOWLIST.length);
  });

  await check("status of one app is honest about running/installed", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)] });
    h.addProc("Notepad.exe");
    const res = await h.control.run({ action: "status", app: "notepad" });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.installed, true);
    assert.strictEqual(res.running, true);
    assert.strictEqual(res.closeable, true);
  });

  // -- browser handoff ------------------------------------------------------

  await check("openUrl rejects non-web schemes before spawning anything", async () => {
    const chrome = APP_BY_KEY.get("chrome");
    const h = createHarness({ exists: [exePath(chrome)] });
    for (const url of ["javascript:alert(1)", "file:///C:/secret.txt", "data:text/html,<h1>x</h1>"]) {
      const res = await h.control.run({ action: "openUrl", app: "chrome", url });
      assert.strictEqual(res.ok, false, url);
      assert.strictEqual(res.error, "unsupportedUrl", url);
    }
    assert.strictEqual(h.spawns.length, 0);
  });

  await check("openUrl refuses apps that are not browsers", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)] });
    const res = await h.control.run({ action: "openUrl", app: "notepad", url: "https://example.com" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "notABrowser");
    assert.strictEqual(h.spawns.length, 0);
  });

  await check("openSearch builds the encoded Google URL in trusted code", async () => {
    const chrome = APP_BY_KEY.get("chrome");
    const h = createHarness({ exists: [exePath(chrome)] });
    const res = await h.control.run({
      action: "openSearch",
      app: "chrome",
      query: "Python tutorials",
    });

    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.action, "openSearch");
    assert.strictEqual(res.query, "Python tutorials");
    assert.deepStrictEqual(h.spawns[0].args, [
      "https://www.google.com/search?q=Python%20tutorials",
    ]);
  });

  await check("openFolder verifies the folder in the window title", async () => {
    const vscode = APP_BY_KEY.get("vscode");
    const h = createHarness({
      exists: [exePath(vscode)],
      dirs: ["C:\\work\\myproj", "C:\\work\\other"],
    });

    h.setTitle("Code.exe", "myproj - Visual Studio Code");
    const ok = await h.control.run({
      action: "openFolder",
      app: "vscode",
      folder: "C:\\work\\myproj",
    });
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.strictEqual(ok.verified, true);
    assert.strictEqual(ok.folderName, "myproj");
    assert.deepStrictEqual(h.spawns[0].args, ["C:\\work\\myproj"]);

    h.setTitle("Code.exe", "something else entirely");
    const unverified = await h.control.run({
      action: "openFolder",
      app: "vscode",
      folder: "C:\\work\\other",
    });
    assert.strictEqual(unverified.ok, false);
    assert.strictEqual(unverified.error, "folderOpenUnverified");
  });

  await check("openFolder rejects missing folders and non-folder targets", async () => {
    const vscode = APP_BY_KEY.get("vscode");
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(vscode), exePath(notepad)] });

    const missing = await h.control.run({
      action: "openFolder",
      app: "vscode",
      folder: "C:\\nope\\missing",
    });
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.error, "folderNotFound");

    const relative = await h.control.run({ action: "openFolder", app: "vscode", folder: "some/rel" });
    assert.strictEqual(relative.error, "folderNotAbsolute");

    const wrongApp = await h.control.run({
      action: "openFolder",
      app: "notepad",
      folder: "C:\\nope",
    });
    assert.strictEqual(wrongApp.error, "notAFolderTarget");
  });

  // -- audit hygiene --------------------------------------------------------

  await check("audit events carry the app key, never paths or arguments", async () => {
    const notepad = APP_BY_KEY.get("notepad");
    const h = createHarness({ exists: [exePath(notepad)] });
    h.addProc("Notepad.exe");
    await h.control.run({ action: "launch", app: "notepad" });
    await h.control.run({ action: "minimize", app: "notepad" });

    const serialised = JSON.stringify(h.audits);
    assert.ok(!serialised.includes("C:\\\\"), "audit must not contain filesystem paths");
    assert.ok(h.audits.some((event) => event.app === "notepad"));
    assert.ok(h.audits.some((event) => event.event === "APP_WINDOW_ACTION"));
  });

  await check("unsupported platform and unknown actions fail closed", async () => {
    const mac = createAppControl({ audit: () => {}, platform: "darwin", env: ENV });
    const res = await mac.run({ action: "launch", app: "chrome" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "unsupportedPlatform");

    const h = createHarness();
    const unknown = await h.control.run({ action: "shutdownWindows" });
    assert.strictEqual(unknown.ok, false);
    assert.strictEqual(unknown.error, "unsupportedAction");
    assert.strictEqual(h.spawns.length, 0);
  });

  console.log("\n==================================================");
  if (failures.length > 0) {
    console.error("  " + failures.length + " APP CONTROL CHECK(S) FAILED");
    console.log("==================================================");
    process.exit(1);
  }
  console.log("  ALL " + passed + " APP CONTROL CHECKS PASSED");
  console.log("==================================================");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
