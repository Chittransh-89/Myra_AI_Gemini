"use strict";

/**
 * Myra AI — Application allowlist (Phase 3).
 *
 * PURE DATA + PURE MATCHING. No filesystem, no processes, no Electron. This is
 * the security boundary for desktop app control: the model may only ever name
 * an application that exists in this list. Model-supplied paths, executables or
 * command lines are never accepted — only an allowlist key/alias/title is, and
 * only the trusted main-process controller turns that into a launch target.
 *
 * Each entry describes:
 *   key             stable identifier used in results and audit logs
 *   title           human name spoken back to the user
 *   aliases         names/translations the model may pass ("vs code", "code")
 *   images          process image names used for running/window detection
 *   exeCandidates   absolute install locations (%VAR% expanded at runtime)
 *   searchRoots     one-level version folders for Electron-style installs
 *   uwp             optional AppsFolder AUMID for store apps
 *   protocol        optional OS protocol handler (ms-settings: etc.)
 *   builtin         ships with Windows (installed even without an exe probe)
 *   closeable       false => Myra refuses to close it (shell / desktop host)
 *   browser         may be given a URL to open
 *   supportsFolder  may be given a folder to open
 *
 * Adding an app here is the ONLY way to grant Myra control over it.
 */

const MAX_APP_QUERY_LEN = 80;
const MAX_ALIAS_LEN = 60;

const APP_ALLOWLIST = Object.freeze([
  {
    key: "vscode",
    title: "Visual Studio Code",
    aliases: [
      "vs code",
      "vscode",
      "vs-code",
      "visual studio code",
      "microsoft visual studio code",
      "code editor",
      "code",
    ],
    images: ["Code.exe"],
    closeable: true,
    supportsFolder: true,
    exeCandidates: [
      "%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe",
      "%ProgramFiles%\\Microsoft VS Code\\Code.exe",
      "%ProgramFiles(x86)%\\Microsoft VS Code\\Code.exe",
    ],
  },
  {
    key: "notepad",
    title: "Notepad",
    aliases: ["notepad", "note pad", "text editor", "simple editor"],
    images: ["Notepad.exe"],
    closeable: true,
    exeCandidates: ["%SystemRoot%\\System32\\notepad.exe", "%SystemRoot%\\notepad.exe"],
  },
  {
    key: "calculator",
    title: "Calculator",
    aliases: ["calculator", "calc", "calculator app"],
    images: ["CalculatorApp.exe", "WindowsCalculator.exe", "Calculator.exe", "calc.exe"],
    closeable: true,
    exeCandidates: ["%SystemRoot%\\System32\\calc.exe"],
    uwp: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
  },
  {
    key: "paint",
    title: "Paint",
    aliases: ["paint", "mspaint", "paint app"],
    images: ["mspaint.exe", "PaintApp.exe"],
    closeable: true,
    exeCandidates: ["%SystemRoot%\\System32\\mspaint.exe"],
  },
  {
    key: "settings",
    title: "Windows Settings",
    aliases: ["settings", "windows settings", "system settings"],
    images: ["SystemSettings.exe"],
    closeable: true,
    protocol: "ms-settings:",
    builtin: true,
  },
  {
    key: "fileexplorer",
    title: "File Explorer",
    aliases: ["file explorer", "explorer", "files", "file manager", "folder", "my files"],
    images: ["explorer.exe"],
    // explorer.exe also hosts the Windows shell (taskbar/desktop). Closing it
    // would tear down the user's desktop, so it is launch-only.
    closeable: false,
    supportsFolder: true,
    exeCandidates: ["%SystemRoot%\\explorer.exe"],
  },
  {
    key: "snippingtool",
    title: "Snipping Tool",
    aliases: ["snipping tool", "screenshot tool", "screen snip", "snip"],
    images: ["SnippingTool.exe", "ScreenClippingHost.exe"],
    closeable: true,
    exeCandidates: ["%SystemRoot%\\System32\\SnippingTool.exe"],
    protocol: "ms-screenclip:",
  },
  {
    key: "taskmanager",
    title: "Task Manager",
    aliases: ["task manager", "taskmgr"],
    images: ["Taskmgr.exe"],
    closeable: true,
    exeCandidates: ["%SystemRoot%\\System32\\Taskmgr.exe"],
  },
  {
    key: "chrome",
    title: "Google Chrome",
    aliases: ["chrome", "google chrome", "chrome browser"],
    images: ["chrome.exe"],
    closeable: true,
    browser: true,
    exeCandidates: [
      "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
      "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
      "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
    ],
  },
  {
    key: "edge",
    title: "Microsoft Edge",
    aliases: ["edge", "microsoft edge", "msedge"],
    images: ["msedge.exe"],
    closeable: true,
    browser: true,
    exeCandidates: [
      "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
  },
  {
    key: "firefox",
    title: "Mozilla Firefox",
    aliases: ["firefox", "mozilla firefox"],
    images: ["firefox.exe"],
    closeable: true,
    browser: true,
    exeCandidates: [
      "%ProgramFiles%\\Mozilla Firefox\\firefox.exe",
      "%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe",
    ],
  },
  {
    key: "brave",
    title: "Brave",
    aliases: ["brave", "brave browser"],
    images: ["brave.exe"],
    closeable: true,
    browser: true,
    exeCandidates: [
      "%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ],
  },
  {
    key: "word",
    title: "Microsoft Word",
    aliases: ["word", "microsoft word", "ms word"],
    images: ["WINWORD.EXE"],
    closeable: true,
    supportsFolder: false,
    exeCandidates: [
      "%ProgramFiles%\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
      "%ProgramFiles(x86)%\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
    ],
  },
  {
    key: "excel",
    title: "Microsoft Excel",
    aliases: ["excel", "microsoft excel", "ms excel"],
    images: ["EXCEL.EXE"],
    closeable: true,
    exeCandidates: [
      "%ProgramFiles%\\Microsoft Office\\root\\Office16\\EXCEL.EXE",
      "%ProgramFiles(x86)%\\Microsoft Office\\root\\Office16\\EXCEL.EXE",
    ],
  },
  {
    key: "powerpoint",
    title: "Microsoft PowerPoint",
    aliases: ["powerpoint", "power point", "microsoft powerpoint", "ppt"],
    images: ["POWERPNT.EXE"],
    closeable: true,
    exeCandidates: [
      "%ProgramFiles%\\Microsoft Office\\root\\Office16\\POWERPNT.EXE",
      "%ProgramFiles(x86)%\\Microsoft Office\\root\\Office16\\POWERPNT.EXE",
    ],
  },
  {
    key: "outlook",
    title: "Microsoft Outlook",
    aliases: ["outlook", "microsoft outlook"],
    images: ["OUTLOOK.EXE"],
    closeable: true,
    exeCandidates: [
      "%ProgramFiles%\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE",
      "%ProgramFiles(x86)%\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE",
    ],
  },
  {
    key: "teams",
    title: "Microsoft Teams",
    aliases: ["teams", "microsoft teams", "ms teams"],
    images: ["ms-teams.exe", "Teams.exe"],
    closeable: true,
    exeCandidates: [
      "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\ms-teams.exe",
      "%ProgramFiles%\\WindowsApps\\MSTeams_8wekyb3d8bbwe\\ms-teams.exe",
    ],
    uwp: "MSTeams_8wekyb3d8bbwe!MSTeams",
  },
  {
    key: "whatsapp",
    title: "WhatsApp",
    aliases: ["whatsapp", "whats app"],
    images: ["WhatsApp.exe"],
    closeable: true,
    exeCandidates: ["%LOCALAPPDATA%\\WhatsApp\\WhatsApp.exe"],
  },
  {
    key: "telegram",
    title: "Telegram",
    aliases: ["telegram"],
    images: ["Telegram.exe"],
    closeable: true,
    exeCandidates: ["%APPDATA%\\Telegram Desktop\\Telegram.exe"],
  },
  {
    key: "discord",
    title: "Discord",
    aliases: ["discord"],
    images: ["Discord.exe"],
    closeable: true,
    // Discord installs into %LOCALAPPDATA%\Discord\app-<version>\Discord.exe
    searchRoots: [{ dir: "%LOCALAPPDATA%\\Discord", file: "Discord.exe" }],
  },
  {
    key: "spotify",
    title: "Spotify",
    aliases: ["spotify", "music"],
    images: ["Spotify.exe"],
    closeable: true,
    exeCandidates: ["%APPDATA%\\Spotify\\Spotify.exe"],
  },
  {
    key: "zoom",
    title: "Zoom",
    aliases: ["zoom", "zoom meeting"],
    images: ["Zoom.exe"],
    closeable: true,
    exeCandidates: ["%APPDATA%\\Zoom\\bin\\Zoom.exe"],
  },
  {
    key: "vlc",
    title: "VLC media player",
    aliases: ["vlc", "vlc player", "media player"],
    images: ["vlc.exe"],
    closeable: true,
    exeCandidates: [
      "%ProgramFiles%\\VideoLAN\\VLC\\vlc.exe",
      "%ProgramFiles(x86)%\\VideoLAN\\VLC\\vlc.exe",
    ],
  },
  {
    key: "steam",
    title: "Steam",
    aliases: ["steam"],
    images: ["steam.exe"],
    closeable: true,
    exeCandidates: ["%ProgramFiles(x86)%\\Steam\\steam.exe", "%ProgramFiles%\\Steam\\steam.exe"],
  },
]);

const APP_BY_KEY = new Map(APP_ALLOWLIST.map((entry) => [entry.key, entry]));

/** "name" / "Name.exe" -> lowercase without extension. */
function normalizeProcessName(name) {
  return String(name == null ? "" : name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\.exe$/, "");
}

/** Executable image names are only ever taken from the allowlist; still verify. */
function isImageNameSafe(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\.exe$/i.test(name);
}

/** Allowlist entry that owns this running process image, or null. */
function entryForProcess(processName) {
  const base = normalizeProcessName(processName);
  if (!base) return null;
  for (const entry of APP_ALLOWLIST) {
    for (const image of entry.images) {
      if (normalizeProcessName(image) === base) return entry;
    }
  }
  return null;
}

/** Expand %VAR% segments of a Windows path. Unknown vars stay literal. */
function expandEnvPath(raw, env = process.env) {
  if (typeof raw !== "string" || !raw) return "";
  return raw.replace(/%([A-Za-z0-9_() ]+)%/g, (whole, name) => {
    const direct = env ? env[name] : undefined;
    if (typeof direct === "string" && direct) return direct;
    const upper = env ? env[String(name).toUpperCase()] : undefined;
    return typeof upper === "string" && upper ? upper : whole;
  });
}

/**
 * Normalise a spoken/natural app reference.
 * "Open  VS-Code.exe!" -> "vs code"; "Chrome kholo" -> "chrome kholo".
 */
function cleanAppQuery(raw) {
  if (typeof raw !== "string") return "";
  let text = raw.trim().toLowerCase();
  if (text.length > MAX_APP_QUERY_LEN) text = text.slice(0, MAX_APP_QUERY_LEN);
  text = text.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (text.endsWith(" exe")) text = text.slice(0, -4).trim();
  return text;
}

const SELF_REFERENCE_ALIASES = Object.freeze([
  "this",
  "this app",
  "this application",
  "this window",
  "current",
  "current app",
  "active",
  "active app",
  "focused app",
  "foreground app",
  "it",
  "same app",
  "isko",
  "ise",
  "ye",
  "yeh",
  "yahi",
  "is app",
  "is application",
]);

const PREVIOUS_REFERENCE_ALIASES = Object.freeze([
  "previous",
  "previous app",
  "last",
  "last app",
  "pichla",
  "pichhla",
  "pichli app",
  "wahi",
]);

const SELF_REFERENCE = new Set(SELF_REFERENCE_ALIASES.map(cleanAppQuery));
const PREVIOUS_REFERENCE = new Set(PREVIOUS_REFERENCE_ALIASES.map(cleanAppQuery));

function isSelfReference(raw) {
  return SELF_REFERENCE.has(cleanAppQuery(raw));
}

function isPreviousReference(raw) {
  return PREVIOUS_REFERENCE.has(cleanAppQuery(raw));
}

const GENERIC_BROWSER_QUERIES = new Set(
  ["browser", "web browser", "internet", "internet browser", "default browser", "brave browser"].map(
    cleanAppQuery
  )
);

/** "browser" on its own names a ROLE, not an app: resolve across browsers. */
function isGenericBrowserQuery(raw) {
  return GENERIC_BROWSER_QUERIES.has(cleanAppQuery(raw));
}

function hasWholePhrase(haystack, needle) {
  if (!haystack || !needle) return false;
  return (" " + haystack + " ").indexOf(" " + needle + " ") !== -1;
}

/**
 * Rank allowlist entries against a spoken name.
 * Exact key/title/alias beats "the phrase appears inside the query"
 * ("chrome kholo"), which beats "the query appears inside the name"
 * ("chrom" -> Chrome).
 */
function matchApps(rawQuery) {
  const query = cleanAppQuery(rawQuery);
  if (!query) return [];
  const queryTokens = query.split(" ").filter(Boolean);

  const scored = [];
  for (const entry of APP_ALLOWLIST) {
    const names = [entry.key, entry.title, ...entry.aliases]
      .map(cleanAppQuery)
      .filter((name) => name.length > 0 && name.length <= MAX_ALIAS_LEN);

    let best = 0;
    for (const name of names) {
      if (name === query) {
        best = Math.max(best, 100 + name.length);
        continue;
      }
      if (hasWholePhrase(query, name)) {
        best = Math.max(best, 80 + name.length);
        continue;
      }
      if (name.length >= 4 && hasWholePhrase(name, query)) {
        best = Math.max(best, 60 + query.length);
        continue;
      }
      const nameTokens = name.split(" ");
      const everyQueryTokenNamed = queryTokens.every(
        (token) =>
          token.length >= 3 &&
          nameTokens.some((candidate) => candidate === token || candidate.startsWith(token))
      );
      if (everyQueryTokenNamed) best = Math.max(best, 40 + query.length);
    }

    if (best === 0 && query.length >= 3) {
      // Unambiguous prefix ("chrom", "notep").
      const prefixed = names.some((name) => name.length >= 4 && name.startsWith(query));
      if (prefixed) best = 30 + query.length;
    }

    if (best > 0) scored.push({ entry, score: best });
  }

  scored.sort((a, b) => b.score - a.score || a.entry.key.localeCompare(b.entry.key));
  return scored;
}

/** Small set of near names used to ask a useful clarification question. */
function suggestApps(rawQuery, limit = 4) {
  const query = cleanAppQuery(rawQuery);
  const matches = matchApps(query).map((m) => m.entry);
  if (matches.length > 0) return matches.slice(0, limit);
  const cleaned = query.replace(/\s+/g, "");
  if (!cleaned) return [];
  const near = APP_ALLOWLIST.filter((entry) => {
    const names = [entry.key, entry.title, ...entry.aliases].map(cleanAppQuery);
    return names.some((name) => {
      const flat = name.replace(/\s+/g, "");
      return flat.length >= 3 && (flat.startsWith(cleaned.slice(0, 3)) || cleaned.startsWith(flat.slice(0, 3)));
    });
  });
  return near.slice(0, limit);
}

module.exports = {
  APP_ALLOWLIST,
  APP_BY_KEY,
  MAX_APP_QUERY_LEN,
  SELF_REFERENCE_ALIASES,
  PREVIOUS_REFERENCE_ALIASES,
  cleanAppQuery,
  expandEnvPath,
  normalizeProcessName,
  isImageNameSafe,
  entryForProcess,
  isSelfReference,
  isPreviousReference,
  isGenericBrowserQuery,
  matchApps,
  suggestApps,
};
