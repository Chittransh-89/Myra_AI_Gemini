"use strict";

/**
 * Myra AI — Smart app & window control (Phase 3, ELECTRON MAIN PROCESS ONLY).
 *
 * Security model
 * --------------
 *  - The model never supplies an executable, path or command line. It supplies
 *    a NAME. Only `appCatalog.cjs` allowlist entries can be resolved, and the
 *    trusted resolution below turns that entry into a concrete launch target.
 *  - No shell is ever used: `spawn(exe, [args], { shell:false })` with args that
 *    are allowlist constants (or a validated URL / existing folder path).
 *  - Closing uses `taskkill /PID <verified pid>` — never image-name matching —
 *    so unrelated processes with a similar name cannot be killed. A PID is only
 *    killed if Myra's own process enumeration matched an allowlisted image, and
 *    it is re-checked before a forced kill (PID reuse).
 *  - Window operations run a FIXED PowerShell script; the app image names travel
 *    in environment variables (never interpolated into script text).
 *  - Closing an app is destructive: it needs a one-time approvalId minted by
 *    this main-process module (prepare -> user confirms -> close).
 *  - `explorer.exe` is launch-only (it hosts the Windows shell).
 *  - Every action is audited with metadata only (app KEY, action, reason).
 *
 * Every mutating action VERIFIES its outcome (process present/absent, window
 * state, foreground process). When verification fails the result is `ok:false`
 * with an explicit error — Myra never claims a success she did not observe.
 */

const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  APP_ALLOWLIST,
  APP_BY_KEY,
  expandEnvPath,
  normalizeProcessName,
  isImageNameSafe,
  entryForProcess,
  isSelfReference,
  isPreviousReference,
  isGenericBrowserQuery,
  matchApps,
  suggestApps,
  cleanAppQuery,
  MAX_APP_QUERY_LEN,
} = require("./appCatalog.cjs");

const MAX_LAUNCH_ATTEMPTS = 2;
const MAX_WINDOW_RETRIES = 1;
const MAX_APPROVALS = 8;
const MAX_RECENT = 8;
const MAX_QUERY_CHARS = 200;
const MAX_FOLDER_PATH = 260;
const MAX_URL_CHARS = 2048;

const DEFAULT_TIMEOUTS = Object.freeze({
  launchVerifyMs: 8000,
  launchPollMs: 400,
  closeVerifyMs: 4000,
  closePollMs: 250,
  windowRetryMs: 500,
  windowSettleMs: 350,
  folderVerifyMs: 6000,
  approvalTtlMs: 120000,
  installCacheMs: 60000,
});

const WINDOW_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Add-Type -Namespace MyraWin -Name Native -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(System.IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool IsIconic(System.IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool IsZoomed(System.IntPtr hWnd);'",
  "$action = $env:MYRA_WIN_ACTION",
  "$names = ($env:MYRA_WIN_IMAGES -split ',') | Where-Object { $_ -ne '' }",
  "foreach ($n in $names) {",
  "  $procs = Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }",
  "  foreach ($p in $procs) {",
  "    $h = $p.MainWindowHandle",
  "    if ($action -eq 'minimize') { [void][MyraWin.Native]::ShowWindowAsync($h, 6) }",
  "    elseif ($action -eq 'maximize') { [void][MyraWin.Native]::ShowWindowAsync($h, 3) }",
  "    elseif ($action -eq 'restore') { [void][MyraWin.Native]::ShowWindowAsync($h, 9) }",
  "    elseif ($action -eq 'focus') { [void][MyraWin.Native]::ShowWindowAsync($h, 9); [void][MyraWin.Native]::SetForegroundWindow($h) }",
  "  }",
  "}",
  "Start-Sleep -Milliseconds 250",
  "$out = @()",
  "foreach ($n in $names) {",
  "  $procs = Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }",
  "  foreach ($p in $procs) {",
  "    $h = $p.MainWindowHandle",
  "    $out += [pscustomobject]@{ name = $n; pid = $p.Id; hwnd = $h.ToInt64(); iconic = [MyraWin.Native]::IsIconic($h); zoomed = [MyraWin.Native]::IsZoomed($h) }",
  "  }",
  "}",
  "[pscustomobject]@{ windows = @($out) } | ConvertTo-Json -Compress -Depth 4",
].join("\n");

const ACTIVE_WINDOW_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Add-Type -Namespace MyraWin -Name Fg -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(System.IntPtr hWnd, out int pid);'",
  "$handle = [MyraWin.Fg]::GetForegroundWindow()",
  "$fgPid = 0",
  "[void][MyraWin.Fg]::GetWindowThreadProcessId($handle, [ref]$fgPid)",
  "$proc = Get-Process -Id $fgPid -ErrorAction SilentlyContinue",
  "[pscustomobject]@{ pid = $fgPid; name = $proc.ProcessName; title = $proc.MainWindowTitle } | ConvertTo-Json -Compress",
].join("\n");

const WINDOW_TITLES_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$items = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; pid = $_.Id; title = $_.MainWindowTitle } }",
  "[pscustomobject]@{ windows = @($items) } | ConvertTo-Json -Compress -Depth 4",
].join("\n");

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Parse `tasklist /FO CSV /NH` without assuming locale-specific headers. */
function parseTasklistCsv(text) {
  const out = [];
  for (const rawLine of String(text == null ? "" : text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^"([^"]{1,120})","(\d{1,10})"/);
    if (!match) continue;
    const pid = parseInt(match[2], 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    out.push({ name: match[1], pid });
  }
  return out;
}

/** http/https only, no embedded credentials, bounded length. */
function validateWebUrl(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "invalidUrl" };
  const text = raw.trim();
  if (!text || text.length > MAX_URL_CHARS) return { ok: false, reason: "invalidUrl" };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, reason: "invalidUrl" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "unsupportedUrl" };
  }
  if (parsed.username || parsed.password) return { ok: false, reason: "credentialsInUrl" };
  return { ok: true, url: parsed.toString() };
}

/** Absolute, existing, local directory path only. */
function validateFolderPath(raw, pathInfo) {
  if (typeof raw !== "string") return { ok: false, reason: "invalidFolder" };
  const text = raw.trim();
  if (!text || text.length > MAX_FOLDER_PATH) return { ok: false, reason: "invalidFolder" };
  if (/[\u0000-\u001f]/.test(text)) return { ok: false, reason: "invalidFolder" };
  if (!path.isAbsolute(text)) return { ok: false, reason: "folderNotAbsolute" };
  const info = pathInfo(text);
  if (!info.exists) return { ok: false, reason: "folderNotFound" };
  if (!info.isDirectory) return { ok: false, reason: "notADirectory" };
  return { ok: true, path: text, name: path.basename(text) };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? [value] : [];
}

function parseJsonText(text) {
  const trimmed = String(text == null ? "" : text).replace(/^\uFEFF/, "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function execFileP(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        ...options,
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout == null ? "" : stdout),
          stderr: String(stderr == null ? "" : stderr),
          code: err ? String(err.code || "execFailed") : null,
        });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

function createAppControl(options = {}) {
  const {
    audit = () => {},
    log = () => {},
    platform = process.platform,
    env = process.env,
    deps = {},
    timeouts = {},
  } = options;

  const record = typeof audit === "function" ? audit : () => {};
  const emit = typeof log === "function" ? log : () => {};
  const t = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;

  const pathInfo =
    deps.pathInfo ||
    ((target) => {
      try {
        const stat = fs.statSync(target);
        return { exists: true, isDirectory: stat.isDirectory() };
      } catch {
        return { exists: false, isDirectory: false };
      }
    });

  const readDirNames =
    deps.readDirNames ||
    ((target) => {
      try {
        return fs.readdirSync(target, { withFileTypes: true }).map((entry) => entry.name);
      } catch {
        return [];
      }
    });

  async function listProcesses() {
    if (typeof deps.listProcesses === "function") {
      try {
        const list = await deps.listProcesses();
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    }
    if (platform !== "win32") return [];
    const csv = await execFileP("tasklist", ["/FO", "CSV", "/NH"], { timeout: 8000 });
    if (csv.ok) {
      const parsed = parseTasklistCsv(csv.stdout);
      if (parsed.length > 0) return parsed;
    }
    // Recovery: tasklist can be unavailable/blocked. Fall back to PowerShell.
    const ps = await execFileP(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "[pscustomobject]@{ procs = @(Get-Process | ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; pid = $_.Id } }) } | ConvertTo-Json -Compress -Depth 4",
      ],
      { timeout: 12000 }
    );
    if (!ps.ok) return [];
    const parsed = parseJsonText(ps.stdout);
    return asArray(parsed && parsed.procs).map((proc) => ({
      name: String(proc && proc.name ? proc.name : ""),
      pid: Number(proc && proc.pid),
    }));
  }

  async function spawnDetached(exe, args) {
    if (typeof deps.spawnDetached === "function") return deps.spawnDetached(exe, args);
    return new Promise((resolve) => {
      let settled = false;
      let child = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        child = spawn(exe, args, {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
          shell: false,
        });
      } catch (err) {
        return finish({ ok: false, error: err && err.code === "ENOENT" ? "exeNotFound" : "launchFailed" });
      }
      child.once("error", (err) => {
        finish({ ok: false, error: err && err.code === "ENOENT" ? "exeNotFound" : "launchFailed" });
      });
      child.once("spawn", () => {
        try {
          child.unref();
        } catch {
          /* already detached */
        }
        finish({ ok: true, pid: child.pid || null });
      });
      setTimeout(() => {
        try {
          child.unref();
        } catch {
          /* ignore */
        }
        finish({ ok: true, pid: (child && child.pid) || null, slow: true });
      }, 4000);
    });
  }

  async function killPid(pid, force) {
    if (typeof deps.killPid === "function") return deps.killPid(pid, force);
    if (platform !== "win32") return { ok: false, error: "unsupportedPlatform" };
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const result = await execFileP("taskkill", args, { timeout: 8000 });
    return { ok: result.ok, error: result.ok ? null : result.stderr.trim().slice(0, 80) || "killFailed" };
  }

  async function runScript(script, extraEnv, timeoutMs) {
    if (typeof deps.runScript === "function") return deps.runScript(script, extraEnv || {}, timeoutMs);
    if (platform !== "win32") return { ok: false, windows: [] };
    const result = await execFileP(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: timeoutMs || 15000, env: { ...env, ...(extraEnv || {}) } }
    );
    if (!result.ok) return { ok: false, windows: [] };
    const parsed = parseJsonText(result.stdout);
    return { ok: true, windows: asArray(parsed && parsed.windows) };
  }

  async function windows(action, images) {
    if (typeof deps.windows === "function") return deps.windows(action, images);
    const safe = images.filter(isImageNameSafe).map(normalizeProcessName).filter(Boolean);
    if (safe.length === 0) return { ok: false, windows: [] };
    return runScript(WINDOW_SCRIPT, { MYRA_WIN_ACTION: action, MYRA_WIN_IMAGES: safe.join(",") }, 20000);
  }

  async function activeWindow() {
    if (typeof deps.activeWindow === "function") return deps.activeWindow();
    if (platform !== "win32") return null;
    const result = await execFileP(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ACTIVE_WINDOW_SCRIPT],
      { timeout: 12000, env: { ...env } }
    );
    if (!result.ok) return null;
    const parsed = parseJsonText(result.stdout);
    if (!parsed || typeof parsed !== "object") return null;
    const pid = Number(parsed.pid);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return {
      pid,
      name: String(parsed.name || ""),
      title: String(parsed.title || ""),
    };
  }

  async function windowTitles() {
    if (typeof deps.windowTitles === "function") return deps.windowTitles();
    const result = await runScript(WINDOW_TITLES_SCRIPT, {}, 15000);
    return result.ok ? result.windows : [];
  }

  async function openExternalDefault(target) {
    if (typeof deps.openExternal === "function") return deps.openExternal(target);
    const { shell } = require("electron");
    return shell.openExternal(target);
  }

  // -- state ---------------------------------------------------------------

  const approvals = new Map(); // approvalId -> { appKey, action, used, expiresAt }
  const installCache = new Map(); // appKey -> { installed, path, at }
  const inflight = new Map(); // appKey -> Promise (dedupe concurrent launches)
  let lastApp = null;
  let lastAction = null;
  let recentApps = [];

  function pruneApprovals() {
    const nowMs = now();
    for (const [id, entry] of approvals) {
      if (entry.used || entry.expiresAt < nowMs) approvals.delete(id);
    }
  }

  function mintApproval(appKey, action) {
    pruneApprovals();
    while (approvals.size >= MAX_APPROVALS) {
      const oldest = approvals.keys().next().value;
      if (oldest === undefined) break;
      approvals.delete(oldest);
    }
    const id = crypto.randomBytes(16).toString("hex");
    approvals.set(id, { appKey, action, used: false, expiresAt: now() + t.approvalTtlMs });
    return id;
  }

  function takeApproval(id, appKey, action) {
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) {
      return { ok: false, reason: "malformedApproval", detail: "Ask the user again and use the new approvalId." };
    }
    const entry = approvals.get(id);
    if (!entry) {
      return { ok: false, reason: "unknownApproval", detail: "That approval is unknown or already used. Ask again." };
    }
    if (entry.used) {
      return { ok: false, reason: "approvalReused", detail: "That approval was already used. Ask again." };
    }
    if (entry.expiresAt < now()) {
      approvals.delete(id);
      return { ok: false, reason: "approvalExpired", detail: "That approval expired. Ask again." };
    }
    if (entry.appKey !== appKey || entry.action !== action) {
      return { ok: false, reason: "approvalMismatch", detail: "That approval was for a different app or action." };
    }
    entry.used = true;
    return { ok: true };
  }

  function rememberApp(entry, action) {
    lastApp = { key: entry.key, title: entry.title, at: now() };
    lastAction = action;
    recentApps = [
      { key: entry.key, title: entry.title, action, at: new Date(now()).toISOString() },
      ...recentApps,
    ].slice(0, MAX_RECENT);
  }

  function appInfo(entry) {
    return { key: entry.key, title: entry.title };
  }

  function fail(action, error, detail) {
    const result = { ok: false, action: action || null, error };
    if (detail) result.detail = detail;
    return result;
  }

  // -- resolution ----------------------------------------------------------

  async function processes() {
    const list = await listProcesses();
    return list.filter(
      (proc) => proc && typeof proc.name === "string" && Number.isFinite(proc.pid)
    );
  }

  async function runningInfo(entry) {
    const wanted = entry.images.map((image) => normalizeProcessName(image));
    const procs = (await processes()).filter((proc) =>
      wanted.includes(normalizeProcessName(proc.name))
    );
    return { running: procs.length > 0, procs, pids: procs.map((proc) => proc.pid) };
  }

  /** Installed probe with a short TTL cache (fs churn per tool call avoided). */
  async function installInfo(entry) {
    const cached = installCache.get(entry.key);
    if (cached && now() - cached.at < t.installCacheMs) return cached;

    let installed = entry.builtin === true;
    let launchPath = null;

    if (!installed) {
      for (const candidate of entry.exeCandidates || []) {
        const resolved = expandEnvPath(candidate, env);
        if (!resolved || resolved.indexOf("%") !== -1) continue;
        if (pathInfo(resolved).exists) {
          installed = true;
          launchPath = resolved;
          break;
        }
      }
    }

    if (!installed && Array.isArray(entry.searchRoots)) {
      for (const root of entry.searchRoots) {
        const dir = expandEnvPath(root.dir, env);
        if (!dir || dir.indexOf("%") !== -1) continue;
        for (const name of readDirNames(dir)) {
          const candidate = path.join(dir, name, root.file);
          if (pathInfo(candidate).exists) {
            installed = true;
            launchPath = candidate;
            break;
          }
        }
        if (installed) break;
      }
    }

    const info = { installed, path: launchPath, at: now() };
    installCache.set(entry.key, info);
    return info;
  }

  async function isInstalled(entry) {
    return (await installInfo(entry)).installed;
  }

  async function activeApp() {
    const active = await activeWindow();
    if (!active) {
      return { ok: false, error: "activeWindowUnavailable", detail: "Myra could not read the foreground window." };
    }
    const entry = entryForProcess(active.name);
    if (!entry) {
      return {
        ok: false,
        error: "activeAppNotManageable",
        activeProcess: String(active.name || "").slice(0, 40),
        detail: "The app in front is not on Myra's allowlist, so she cannot control it.",
      };
    }
    return {
      ok: true,
      entry,
      title: String(active.title || "").slice(0, 120),
      pid: active.pid,
    };
  }

  /**
   * Resolve a spoken app reference to an allowlist entry, or return an explicit,
   * user-explainable failure (notInAllowlist / notInstalled / ambiguous).
   */
  async function resolveTarget(rawApp, opts = {}) {
    const allowActiveDefault = opts.allowActiveDefault === true;
    const raw = typeof rawApp === "string" ? rawApp.trim() : "";

    if (!raw || isSelfReference(raw)) {
      if (!raw && !allowActiveDefault) {
        return {
          ok: false,
          error: {
            ok: false,
            error: "missingApp",
            detail: "Tell Myra which application (for example 'chrome' or 'vs code').",
          },
        };
      }
      const active = await activeApp();
      if (!active.ok) {
        return { ok: false, error: { ok: false, error: active.error, detail: active.detail, activeProcess: active.activeProcess || null } };
      }
      return { ok: true, entry: active.entry, resolvedFrom: "activeWindow" };
    }

    if (isPreviousReference(raw)) {
      if (!lastApp) {
        return {
          ok: false,
          error: { ok: false, error: "noPreviousApp", detail: "Myra has no previously used app in this session yet." },
        };
      }
      const entry = APP_BY_KEY.get(lastApp.key);
      if (!entry) {
        return { ok: false, error: { ok: false, error: "noPreviousApp", detail: "The previous app is no longer manageable." } };
      }
      return { ok: true, entry, resolvedFrom: "previousApp" };
    }

    if (isGenericBrowserQuery(raw)) {
      const browsers = [];
      for (const entry of APP_ALLOWLIST) {
        if (entry.browser === true && (await isInstalled(entry))) browsers.push(entry);
      }
      if (browsers.length === 1) return { ok: true, entry: browsers[0], resolvedFrom: "genericBrowser" };
      if (browsers.length === 0) {
        return {
          ok: false,
          error: {
            ok: false,
            error: "appNotInstalled",
            detail: "No allowlisted browser was found on this PC.",
            suggestions: APP_ALLOWLIST.filter((entry) => entry.browser === true).map(appInfo),
          },
        };
      }
      return {
        ok: false,
        error: {
          ok: false,
          error: "ambiguousApp",
          candidates: browsers.map(appInfo),
          detail: "Which browser: " + browsers.map((entry) => entry.title).join(" or ") + "?",
        },
      };
    }

    const matches = matchApps(raw);
    if (matches.length === 0) {
      const suggestions = suggestApps(raw).map(appInfo);
      return {
        ok: false,
        error: {
          ok: false,
          error: "appNotInAllowlist",
          detail:
            "Myra can only control apps on her approved list; \"" +
            raw.slice(0, MAX_APP_QUERY_LEN) +
            "\" is not on it.",
          suggestions,
        },
      };
    }

    const installedMatches = [];
    for (const match of matches) {
      if (await isInstalled(match.entry)) installedMatches.push(match);
    }
    const pool = installedMatches.length > 0 ? installedMatches : matches;
    const topScore = pool[0].score;
    const tied = pool.filter((match) => match.score === topScore);
    if (tied.length > 1) {
      return {
        ok: false,
        error: {
          ok: false,
          error: "ambiguousApp",
          candidates: tied.map((match) => appInfo(match.entry)),
          detail: "That could be more than one app. Which one did you mean?",
        },
      };
    }

    const entry = pool[0].entry;
    if (!(await isInstalled(entry))) {
      return {
        ok: false,
        error: {
          ok: false,
          error: "appNotInstalled",
          app: appInfo(entry),
          detail:
            entry.title + " is on Myra's allowlist but no installation was found on this PC.",
          hint: "Tell the user it is not installed here, and offer an app Myra can control.",
        },
      };
    }
    return { ok: true, entry, resolvedFrom: "name" };
  }

  async function launchPlan(entry) {
    const info = await installInfo(entry);
    const attempts = [];
    if (info.path) attempts.push({ kind: "exe", exe: info.path, args: [] });
    if (entry.uwp) {
      const explorer = expandEnvPath("%SystemRoot%\\explorer.exe", env);
      attempts.push({ kind: "uwp", exe: explorer, args: ["shell:AppsFolder\\" + entry.uwp] });
    }
    if (entry.protocol) attempts.push({ kind: "protocol", target: entry.protocol });
    return attempts;
  }

  async function waitForRunning(entry, timeoutMs) {
    const deadline = now() + timeoutMs;
    for (;;) {
      const info = await runningInfo(entry);
      if (info.running) return { ok: true, pids: info.pids };
      if (now() >= deadline) return { ok: false, pids: [] };
      await sleep(t.launchPollMs);
    }
  }

  async function waitForGone(entry, pids, timeoutMs) {
    const deadline = now() + timeoutMs;
    for (;;) {
      const info = await runningInfo(entry);
      const remaining = pids.filter((pid) => info.pids.includes(pid));
      if (remaining.length === 0) return { ok: true, remaining: [] };
      if (now() >= deadline) return { ok: false, remaining };
      await sleep(t.closePollMs);
    }
  }

  async function waitForWindowTitle(entry, expected, timeoutMs) {
    const wanted = String(expected || "").toLowerCase();
    if (!wanted) return false;
    const wantedImages = entry.images.map(normalizeProcessName);
    const deadline = now() + timeoutMs;
    for (;;) {
      const titles = await windowTitles();
      const hit = asArray(titles).some((item) => {
        const matchesApp = wantedImages.includes(normalizeProcessName(item && item.name));
        return matchesApp && String((item && item.title) || "").toLowerCase().includes(wanted);
      });
      if (hit) return true;
      if (now() >= deadline) return false;
      await sleep(t.launchPollMs);
    }
  }

  async function startAttempt(attempt) {
    if (attempt.kind === "protocol") {
      try {
        await openExternalDefault(attempt.target);
        return { ok: true };
      } catch {
        return { ok: false, error: "launchFailed" };
      }
    }
    return spawnDetached(attempt.exe, attempt.args);
  }

  // -- actions -------------------------------------------------------------

  async function launch(args) {
    const resolved = await resolveTarget(args.app, { allowActiveDefault: false });
    if (!resolved.ok) return { ...resolved.error, action: "launch" };
    const entry = resolved.entry;

    const running = await runningInfo(entry);
    if (running.running) {
      const focus = await focusEntry(entry, { silent: true });
      rememberApp(entry, "launch-reuse");
      record("APP_ALREADY_RUNNING", { tool: "appControl", app: entry.key });
      return {
        ok: true,
        action: "launch",
        app: appInfo(entry),
        launched: false,
        alreadyRunning: true,
        verified: true,
        focused: focus.ok === true,
        pids: running.pids.length,
        detail:
          entry.title +
          " was already running" +
          (focus.ok ? " and is now in front." : " (Myra could not bring it to the front)."),
      };
    }

    if (inflight.has(entry.key)) return inflight.get(entry.key);

    const task = (async () => {
      const attempts = await launchPlan(entry);
      if (attempts.length === 0) {
        return {
          ok: false,
          action: "launch",
          app: appInfo(entry),
          launched: false,
          verified: false,
          error: "appNotInstalled",
          detail: entry.title + " is on Myra's allowlist but no launchable installation was found.",
        };
      }

      let lastError = "launchFailed";
      let attempted = 0;
      for (const attempt of attempts) {
        if (attempted >= MAX_LAUNCH_ATTEMPTS) break;
        attempted++;
        const started = await startAttempt(attempt);
        if (!started.ok) {
          lastError = started.error || "launchFailed";
          record("APP_LAUNCH_FAILED", { tool: "appControl", app: entry.key, reason: lastError });
          // Recovery: a missing exe is transient-install specific — try the next
          // allowlisted target once. Anything else stops here (no retry loop).
          continue;
        }
        const verified = await waitForRunning(entry, t.launchVerifyMs);
        if (verified.ok) {
          rememberApp(entry, "launch");
          record("APP_LAUNCHED", { tool: "appControl", app: entry.key });
          return {
            ok: true,
            action: "launch",
            app: appInfo(entry),
            launched: true,
            alreadyRunning: false,
            verified: true,
            method: attempt.kind,
            pids: verified.pids.length,
            detail: entry.title + " is running.",
          };
        }
        record("APP_LAUNCH_UNVERIFIED", { tool: "appControl", app: entry.key, reason: "timeout" });
        // Started but unconfirmed: do NOT launch a second copy, and never claim success.
        return {
          ok: false,
          action: "launch",
          app: appInfo(entry),
          launched: true,
          verified: false,
          method: attempt.kind,
          error: "launchUnverified",
          detail:
            entry.title +
            " was started, but Myra could not confirm it within " +
            Math.round(t.launchVerifyMs / 1000) +
            "s. It may still be loading.",
        };
      }

      return {
        ok: false,
        action: "launch",
        app: appInfo(entry),
        launched: false,
        verified: false,
        error: lastError,
        detail: "Could not start " + entry.title + ".",
      };
    })().finally(() => inflight.delete(entry.key));

    inflight.set(entry.key, task);
    return task;
  }

  async function close(args) {
    const resolved = await resolveTarget(args.app, { allowActiveDefault: true });
    if (!resolved.ok) return { ...resolved.error, action: "close" };
    const entry = resolved.entry;

    if (entry.closeable === false) {
      record("APP_CLOSE_DENIED", { tool: "appControl", app: entry.key, reason: "notCloseable" });
      return {
        ok: false,
        action: "close",
        app: appInfo(entry),
        error: "closeNotPermitted",
        detail:
          "Myra will not close " +
          entry.title +
          ": it is part of the Windows shell, so closing it would break your desktop.",
      };
    }

    const running = await runningInfo(entry);
    if (!running.running) {
      return {
        ok: false,
        action: "close",
        app: appInfo(entry),
        error: "notRunning",
        detail: entry.title + " is not running.",
      };
    }

    const approvalId = typeof args.approvalId === "string" ? args.approvalId.trim() : "";
    if (!approvalId) {
      const minted = mintApproval(entry.key, "close");
      record("APP_CLOSE_DENIED", { tool: "appControl", app: entry.key, reason: "confirmationRequired" });
      return {
        ok: false,
        action: "close",
        app: appInfo(entry),
        error: "confirmationRequired",
        requiresConfirmation: true,
        approvalId: minted,
        pids: running.pids.length,
        detail:
          "Ask the user to confirm closing " +
          entry.title +
          ", then call close again with this approvalId.",
      };
    }

    const approval = takeApproval(approvalId, entry.key, "close");
    if (!approval.ok) {
      record("APP_CLOSE_DENIED", { tool: "appControl", app: entry.key, reason: approval.reason });
      return {
        ok: false,
        action: "close",
        app: appInfo(entry),
        error: "invalidApproval",
        detail: approval.detail,
      };
    }

    const targets = [...running.pids];
    let signalled = 0;
    for (const pid of targets) {
      const result = await killPid(pid, false);
      if (result && result.ok !== false) signalled++;
    }

    let gone = await waitForGone(entry, targets, t.closeVerifyMs);
    let forced = 0;
    if (!gone.ok) {
      // Re-resolve PIDs before a forced kill so a recycled PID is never hit.
      const current = await runningInfo(entry);
      const still = current.pids.filter((pid) => targets.includes(pid));
      for (const pid of still) {
        const result = await killPid(pid, true);
        if (result && result.ok !== false) forced++;
      }
      if (still.length > 0) gone = await waitForGone(entry, targets, t.closeVerifyMs);
    }

    rememberApp(entry, "close");
    record(gone.ok ? "APP_CLOSED" : "APP_CLOSE_FAILED", {
      tool: "appControl",
      app: entry.key,
      reason: gone.ok ? "closed" : "stillRunning",
    });

    return {
      ok: gone.ok,
      action: "close",
      app: appInfo(entry),
      closed: gone.ok,
      signalled,
      forced: forced > 0,
      remaining: gone.remaining.length,
      verified: true,
      detail: gone.ok
        ? entry.title + " was closed" + (forced > 0 ? " (forced)." : "." )
        : entry.title + " is still running after the close request.",
    };
  }

  function verifyWindowState(action, windows) {
    if (windows.length === 0) return false;
    if (action === "minimize") return windows.every((item) => item.iconic === true);
    if (action === "maximize") return windows.every((item) => item.zoomed === true);
    if (action === "restore") return windows.every((item) => item.iconic !== true);
    return true;
  }

  async function focusEntry(entry, opts = {}) {
    const silent = opts.silent === true;
    const running = await runningInfo(entry);
    if (!running.running) {
      return { ok: false, error: "notRunning", detail: entry.title + " is not running." };
    }
    const images = entry.images.filter(isImageNameSafe).map(normalizeProcessName);
    if (images.length === 0) return { ok: false, error: "unsupportedApp" };

    for (let attempt = 0; attempt <= MAX_WINDOW_RETRIES; attempt++) {
      const result = await windows("focus", images);
      if (!result || result.ok === false) {
        return { ok: false, error: "windowScriptFailed", detail: "Windows did not accept the window command." };
      }
      if (asArray(result.windows).length === 0) {
        return {
          ok: false,
          error: "noVisibleWindow",
          detail: entry.title + " is running but has no visible window yet.",
        };
      }
      await sleep(t.windowSettleMs);
      const active = await activeWindow();
      const activeName = normalizeProcessName(active && active.name);
      const isTarget =
        active &&
        (running.pids.includes(Number(active.pid)) || (activeName && images.includes(activeName)));
      if (isTarget) {
        rememberApp(entry, "focus");
        if (!silent) record("APP_FOCUSED", { tool: "appControl", app: entry.key });
        return {
          ok: true,
          verified: true,
          windows: asArray(result.windows).length,
          detail: entry.title + " is now in front.",
        };
      }
      if (attempt < MAX_WINDOW_RETRIES) await sleep(t.windowRetryMs);
    }

    record("APP_FOCUS_FAILED", { tool: "appControl", app: entry.key, reason: "foregroundMismatch" });
    return {
      ok: false,
      error: "focusBlocked",
      detail:
        "Windows did not let Myra bring " + entry.title + " to the front. A click may be required.",
    };
  }

  async function windowAction(action, args) {
    const resolved = await resolveTarget(args.app, { allowActiveDefault: true });
    if (!resolved.ok) return { ...resolved.error, action };
    const entry = resolved.entry;

    if (action === "focus") {
      const result = await focusEntry(entry);
      return {
        ok: result.ok,
        action,
        app: appInfo(entry),
        verified: result.verified === true,
        windows: result.windows || 0,
        ...(result.ok ? { detail: result.detail } : { error: result.error, detail: result.detail }),
      };
    }

    const running = await runningInfo(entry);
    if (!running.running) {
      return {
        ok: false,
        action,
        app: appInfo(entry),
        error: "notRunning",
        detail: entry.title + " is not running.",
      };
    }
    const images = entry.images.filter(isImageNameSafe).map(normalizeProcessName);
    if (images.length === 0) {
      return { ok: false, action, app: appInfo(entry), error: "unsupportedApp" };
    }

    for (let attempt = 0; attempt <= MAX_WINDOW_RETRIES; attempt++) {
      const result = await windows(action, images);
      if (!result || result.ok === false) {
        return {
          ok: false,
          action,
          app: appInfo(entry),
          error: "windowScriptFailed",
          detail: "Windows did not accept the window command.",
        };
      }
      const list = asArray(result.windows);
      if (list.length === 0) {
        return {
          ok: false,
          action,
          app: appInfo(entry),
          error: "noVisibleWindow",
          detail: entry.title + " is running but has no visible window yet.",
        };
      }
      if (verifyWindowState(action, list)) {
        rememberApp(entry, action);
        record("APP_WINDOW_ACTION", { tool: "appControl", app: entry.key, action });
        return {
          ok: true,
          action,
          app: appInfo(entry),
          verified: true,
          windows: list.length,
          state: list[0].iconic === true ? "minimized" : list[0].zoomed === true ? "maximized" : "normal",
          detail: entry.title + " window: " + action + ".",
        };
      }
      if (attempt < MAX_WINDOW_RETRIES) await sleep(t.windowRetryMs);
    }

    record("APP_WINDOW_FAILED", { tool: "appControl", app: entry.key, action });
    return {
      ok: false,
      action,
      app: appInfo(entry),
      verified: false,
      error: "windowStateUnchanged",
      detail: "Windows did not change the " + entry.title + " window.",
    };
  }

  async function cycle() {
    const procs = await processes();
    const runningEntries = APP_ALLOWLIST.filter((entry) =>
      entry.images.some((image) =>
        procs.some((proc) => normalizeProcessName(proc.name) === normalizeProcessName(image))
      )
    );
    if (runningEntries.length === 0) {
      return {
        ok: false,
        action: "cycle",
        error: "noManageableApps",
        detail: "No app Myra can control is running right now.",
      };
    }
    const active = await activeApp();
    const currentKey = active.ok ? active.entry.key : lastApp ? lastApp.key : null;
    const index = runningEntries.findIndex((entry) => entry.key === currentKey);
    const next = runningEntries[(index + 1) % runningEntries.length];
    const focused = await focusEntry(next);
    rememberApp(next, "cycle");
    return {
      ok: focused.ok,
      action: "cycle",
      app: appInfo(next),
      verified: focused.verified === true,
      candidates: runningEntries.map(appInfo),
      ...(focused.ok ? { detail: focused.detail } : { error: focused.error, detail: focused.detail }),
    };
  }

  async function listRunning() {
    const procs = await processes();
    const apps = [];
    for (const entry of APP_ALLOWLIST) {
      const pids = procs
        .filter((proc) =>
          entry.images.some((image) => normalizeProcessName(image) === normalizeProcessName(proc.name))
        )
        .map((proc) => proc.pid);
      if (pids.length > 0) apps.push({ ...appInfo(entry), pids: pids.length });
    }
    const active = await activeApp();
    return {
      ok: true,
      action: "list",
      count: apps.length,
      apps,
      active: active.ok ? appInfo(active.entry) : null,
      activeManageable: active.ok,
    };
  }

  async function installedList(args) {
    const rawQuery = typeof args.query === "string" ? args.query : "";
    const scoped = rawQuery ? matchApps(rawQuery).map((match) => match.entry) : APP_ALLOWLIST;
    const pool = scoped.length > 0 ? scoped : APP_ALLOWLIST;
    const apps = [];
    for (const entry of pool) {
      apps.push({ ...appInfo(entry), installed: await isInstalled(entry) });
    }
    return {
      ok: true,
      action: "installed",
      query: rawQuery ? cleanAppQuery(rawQuery) : null,
      count: apps.length,
      installedCount: apps.filter((app) => app.installed).length,
      apps,
      note: "Only apps on Myra's allowlist can be launched, closed or resized.",
    };
  }

  async function status(args) {
    const resolved = await resolveTarget(args.app, { allowActiveDefault: true });
    if (!resolved.ok) return { ...resolved.error, action: "status" };
    const entry = resolved.entry;
    const running = await runningInfo(entry);
    return {
      ok: true,
      action: "status",
      app: appInfo(entry),
      installed: await isInstalled(entry),
      running: running.running,
      pids: running.pids.length,
      closeable: entry.closeable !== false,
    };
  }

  async function context() {
    const active = await activeApp();
    const running = await listRunning();
    return {
      ok: true,
      action: "context",
      activeApp: active.ok ? appInfo(active.entry) : null,
      activeWindowTitle: active.ok && active.title ? active.title : null,
      activeManageable: active.ok,
      activeProcess: active.ok ? null : String(active.activeProcess || "").slice(0, 40) || null,
      lastApp: lastApp ? { key: lastApp.key, title: lastApp.title } : null,
      lastAction,
      recent: recentApps.slice(0, 5),
      runningCount: running.count,
      runningApps: running.apps.slice(0, 6).map(appInfo),
      detail: active.ok
        ? "The app in front is " + active.entry.title + "."
        : "The app in front is not on Myra's allowlist.",
    };
  }

  async function openTargetInApp(entry, argument, mode) {
    const plan = await launchPlan(entry);
    const exeAttempt = plan.find((attempt) => attempt.kind === "exe");
    if (!exeAttempt) {
      return {
        ok: false,
        action: mode === "url" ? "openUrl" : "openFolder",
        app: appInfo(entry),
        error: "launchTargetUnavailable",
        detail: entry.title + " has no executable Myra can pass a " + (mode === "url" ? "URL" : "folder") + " to.",
      };
    }
    const wasRunning = (await runningInfo(entry)).running;
    const started = await spawnDetached(exeAttempt.exe, [argument]);
    if (!started || started.ok === false) {
      record("APP_LAUNCH_FAILED", {
        tool: "appControl",
        app: entry.key,
        reason: (started && started.error) || "launchFailed",
      });
      return {
        ok: false,
        action: mode === "url" ? "openUrl" : "openFolder",
        app: appInfo(entry),
        launched: false,
        error: (started && started.error) || "launchFailed",
        detail: "Could not hand the " + mode + " to " + entry.title + ".",
      };
    }
    const verified = await waitForRunning(entry, t.launchVerifyMs);
    if (!verified.ok) {
      record("APP_LAUNCH_UNVERIFIED", { tool: "appControl", app: entry.key, reason: "timeout" });
      return {
        ok: false,
        action: mode === "url" ? "openUrl" : "openFolder",
        app: appInfo(entry),
        launched: true,
        verified: false,
        error: "launchUnverified",
        detail: entry.title + " was started but Myra could not confirm it running.",
      };
    }
    return { ok: true, wasRunning, verified: true };
  }

  async function openUrl(args) {
    const resolved = await resolveTarget(args.app);
    if (!resolved.ok) return { ...resolved.error, action: "openUrl" };
    const entry = resolved.entry;
    if (entry.browser !== true) {
      return {
        ok: false,
        action: "openUrl",
        app: appInfo(entry),
        error: "notABrowser",
        detail: entry.title + " is not a browser Myra can send a URL to.",
      };
    }
    const check = validateWebUrl(args.url);
    if (!check.ok) {
      return {
        ok: false,
        action: "openUrl",
        app: appInfo(entry),
        error: check.reason,
        detail: "Only normal http/https web addresses can be opened.",
      };
    }
    const result = await openTargetInApp(entry, check.url, "url");
    if (!result.ok) return { ...result, url: check.url };
    rememberApp(entry, "openUrl");
    record("APP_URL_OPENED", { tool: "appControl", app: entry.key });
    return {
      ok: true,
      action: "openUrl",
      app: appInfo(entry),
      url: check.url,
      launched: result.wasRunning !== true,
      verified: true,
      tabVerified: false,
      detail:
        entry.title +
        (result.wasRunning ? " opened it in a new window or tab." : " started with it.") +
        " Myra verified the process, not the page contents.",
    };
  }

  async function openSearch(args) {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { ok: false, action: "openSearch", error: "emptyQuery", detail: "What should Myra search for?" };
    }
    if (query.length > MAX_QUERY_CHARS) {
      return { ok: false, action: "openSearch", error: "queryTooLong" };
    }
    const url = "https://www.google.com/search?q=" + encodeURIComponent(query);
    const result = await openUrl({ app: args.app, url });
    return { ...result, action: "openSearch", query };
  }

  async function openFolder(args) {
    let requestedApp = args.app;
    if (!requestedApp || typeof requestedApp !== "string") requestedApp = "vscode";
    const resolved = await resolveTarget(requestedApp);
    if (!resolved.ok) return { ...resolved.error, action: "openFolder" };
    const entry = resolved.entry;

    if (entry.supportsFolder !== true) {
      return {
        ok: false,
        action: "openFolder",
        app: appInfo(entry),
        error: "notAFolderTarget",
        detail: entry.title + " cannot open a project folder for Myra.",
      };
    }
    const folder = validateFolderPath(args.folder, pathInfo);
    if (!folder.ok) {
      const details = {
        folderNotFound: "That folder does not exist.",
        notADirectory: "That path is a file, not a folder.",
        folderNotAbsolute: "Give Myra the full path of the folder.",
        invalidFolder: "That folder path is not usable.",
      };
      return {
        ok: false,
        action: "openFolder",
        app: appInfo(entry),
        error: folder.reason,
        detail: details[folder.reason] || "That folder path is not usable.",
      };
    }

    const result = await openTargetInApp(entry, folder.path, "folder");
    if (!result.ok) return { ...result, folder: folder.path };

    const titleVerified = await waitForWindowTitle(entry, folder.name, t.folderVerifyMs);
    if (!titleVerified) {
      record("APP_FOLDER_UNVERIFIED", { tool: "appControl", app: entry.key, reason: "titleMismatch" });
      return {
        ok: false,
        action: "openFolder",
        app: appInfo(entry),
        folder: folder.path,
        launched: true,
        verified: false,
        error: "folderOpenUnverified",
        detail:
          entry.title +
          " is running, but its window does not show \"" +
          folder.name +
          "\" yet.",
      };
    }

    rememberApp(entry, "openFolder");
    record("APP_FOLDER_OPENED", { tool: "appControl", app: entry.key });
    return {
      ok: true,
      action: "openFolder",
      app: appInfo(entry),
      folder: folder.path,
      folderName: folder.name,
      launched: result.wasRunning !== true,
      verified: true,
      detail: entry.title + " is showing the folder " + folder.name + ".",
    };
  }

  // -- dispatch ------------------------------------------------------------

  async function run(rawArgs) {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    const action = String(args.action || "").trim();
    record("APP_ACTION", { tool: "appControl", action: action || "?" });

    if (platform !== "win32") {
      return fail(action, "unsupportedPlatform", "Desktop app control is a Windows feature.");
    }

    try {
      switch (action) {
        case "launch":
          return await launch(args);
        case "close":
          return await close(args);
        case "minimize":
          return await windowAction("minimize", args);
        case "maximize":
          return await windowAction("maximize", args);
        case "restore":
          return await windowAction("restore", args);
        case "focus":
        case "switch":
          return await windowAction("focus", args);
        case "cycle":
        case "next":
          return await cycle();
        case "list":
        case "running":
          return await listRunning();
        case "installed":
          return await installedList(args);
        case "status":
          return await status(args);
        case "context":
        case "where":
          return await context();
        case "openUrl":
          return await openUrl(args);
        case "openSearch":
          return await openSearch(args);
        case "openFolder":
          return await openFolder(args);
        default:
          return fail(action, "unsupportedAction", "Myra does not know that app action.");
      }
    } catch (err) {
      const reason = String((err && err.code) || (err && err.message) || "appError").slice(0, 80);
      emit("appControl error:", action, reason);
      record("APP_ACTION_FAILED", { tool: "appControl", action: action || "?", reason });
      return fail(action, "appError", "Myra could not complete that app action (" + reason + ").");
    }
  }

  return {
    run,
    /** Read-only resolution used by the multi-step planner. */
    inspectApp: async (rawApp) => {
      const resolved = await resolveTarget(rawApp, { allowActiveDefault: false });
      if (!resolved.ok) return { ...resolved.error };
      const entry = resolved.entry;
      const running = await runningInfo(entry);
      return {
        ok: true,
        app: appInfo(entry),
        installed: await isInstalled(entry),
        running: running.running,
        closeable: entry.closeable !== false,
        browser: entry.browser === true,
        supportsFolder: entry.supportsFolder === true,
      };
    },
    /** Trusted internal helper: the task runner mints approvals with a plan. */
    mintCloseApproval: (appKey) => {
      const entry = APP_BY_KEY.get(String(appKey || ""));
      if (!entry || entry.closeable === false) return null;
      return mintApproval(entry.key, "close");
    },
    dispose: () => {
      approvals.clear();
      inflight.clear();
      installCache.clear();
      recentApps = [];
    },
    // Diagnostics / tests.
    lastApp: () => lastApp,
    pendingApprovals: () => approvals.size,
  };
}

module.exports = {
  createAppControl,
  parseTasklistCsv,
  validateWebUrl,
  validateFolderPath,
  DEFAULT_TIMEOUTS,
  WINDOW_SCRIPT,
  ACTIVE_WINDOW_SCRIPT,
};
