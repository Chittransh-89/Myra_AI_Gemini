"use strict";

/**
 * Myra AI — Phase 3 application allowlist tests.
 *
 * Pins the security boundary itself: what Myra may name, how spoken names
 * resolve, and the follow-up reference tokens ("this", "pichla", "isko").
 */

const assert = require("assert");
const {
  APP_ALLOWLIST,
  APP_BY_KEY,
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
} = require("../electron/lib/appCatalog.cjs");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✔ " + name);
  } catch (err) {
    console.error("  ✘ " + name);
    throw err;
  }
}

console.log("[TEST] Phase 3 app allowlist & name resolution");

check("allowlist keys are unique and every entry is complete", () => {
  const keys = new Set();
  for (const entry of APP_ALLOWLIST) {
    assert.ok(entry.key, "missing key");
    assert.ok(!keys.has(entry.key), "duplicate key " + entry.key);
    keys.add(entry.key);
    assert.ok(entry.title, entry.key + " missing title");
    assert.ok(Array.isArray(entry.images) && entry.images.length > 0, entry.key + " has no images");
    for (const image of entry.images) {
      assert.ok(isImageNameSafe(image), entry.key + " unsafe image " + image);
    }
    assert.ok(
      (entry.aliases || []).length > 0,
      entry.key + " has no aliases; the model could never name it"
    );
    assert.ok(
      (entry.exeCandidates || []).length > 0 ||
        (entry.searchRoots || []).length > 0 ||
        entry.protocol ||
        entry.uwp,
      entry.key + " has no launch target"
    );
  }
  assert.strictEqual(APP_BY_KEY.size, APP_ALLOWLIST.length);
});

check("no executable is reachable outside the allowlist", () => {
  const keys = APP_ALLOWLIST.map((entry) => entry.key);
  assert.ok(keys.includes("vscode"));
  assert.ok(keys.includes("chrome"));
  assert.ok(!keys.includes("cmd"), "shells must never be allowlisted");
  assert.ok(!keys.includes("powershell"));
  assert.ok(!keys.includes("terminal"));
  assert.ok(!keys.includes("wt"));
});

check("File Explorer is launch-only (it hosts the Windows shell)", () => {
  assert.strictEqual(APP_BY_KEY.get("fileexplorer").closeable, false);
  for (const entry of APP_ALLOWLIST) {
    if (entry.key === "fileexplorer") continue;
    assert.notStrictEqual(entry.closeable, false, entry.key + " should be closeable");
  }
});

check("aliases do not collide between different apps", () => {
  const seen = new Map();
  for (const entry of APP_ALLOWLIST) {
    for (const name of [entry.key, ...(entry.aliases || [])]) {
      const clean = cleanAppQuery(name);
      const owner = seen.get(clean);
      assert.ok(
        owner === undefined || owner === entry.key,
        'alias "' + name + '" is claimed by both ' + owner + " and " + entry.key
      );
      seen.set(clean, entry.key);
    }
  }
});

check("query normalisation handles punctuation, case and .exe", () => {
  assert.strictEqual(cleanAppQuery("  VS-Code.exe!  "), "vs code");
  assert.strictEqual(cleanAppQuery("Google   Chrome"), "google chrome");
  assert.strictEqual(cleanAppQuery(""), "");
  assert.strictEqual(cleanAppQuery("चrome"), "चrome");
});

check("spoken English names resolve to the right entry", () => {
  const cases = [
    ["chrome", "chrome"],
    ["Google Chrome", "chrome"],
    ["vs code", "vscode"],
    ["VSCode", "vscode"],
    ["code", "vscode"],
    ["visual studio code", "vscode"],
    ["notepad", "notepad"],
    ["word", "word"],
    ["microsoft word", "word"],
    ["excel", "excel"],
    ["task manager", "taskmanager"],
    ["file explorer", "fileexplorer"],
    ["spotify", "spotify"],
  ];
  for (const [query, expected] of cases) {
    const matches = matchApps(query);
    assert.ok(matches.length > 0, "no match for " + query);
    assert.strictEqual(matches[0].entry.key, expected, query + " -> " + matches[0].entry.key);
  }
});

check("Hinglish sentences still resolve the app name", () => {
  const cases = [
    ["chrome kholo", "chrome"],
    ["notepad band karo", "notepad"],
    ["vs code chalao", "vscode"],
    ["spotify open karo", "spotify"],
  ];
  for (const [query, expected] of cases) {
    assert.strictEqual(matchApps(query)[0].entry.key, expected, query);
  }
});

check("unknown apps are not resolved to anything", () => {
  for (const query of ["photoshop", "minecraft", "cmd", "powershell", "terminal", "explorer123"]) {
    assert.strictEqual(matchApps(query).length, 0, query + " should not match an allowlisted app");
  }
});

check("path-like and executable-like input never resolves", () => {
  for (const query of [
    "C:\\Windows\\System32\\cmd.exe",
    "C:/Windows/notepad.exe",
    "\\\\server\\share\\evil.exe",
    "../../notepad.exe",
  ]) {
    const matches = matchApps(query);
    const keys = matches.map((match) => match.entry.key);
    assert.ok(
      !keys.includes("cmd") && !keys.includes("powershell"),
      query + " must never resolve to a shell"
    );
    // It may accidentally contain "notepad" as a file name; that is still only a
    // NAME match and can never launch the literal path (see appControl tests).
    for (const key of keys) assert.ok(APP_BY_KEY.has(key));
  }
});

check("follow-up references are recognised (English + Hinglish)", () => {
  for (const value of ["this", "current", "active app", "it", "isko", "ise", "yeh", "yahi"]) {
    assert.ok(isSelfReference(value), value + " should be a self reference");
  }
  for (const value of ["previous", "last", "last app", "pichla", "pichhla", "wahi"]) {
    assert.ok(isPreviousReference(value), value + " should be a previous reference");
  }
  for (const value of ["chrome", "notepad", "browser"]) {
    assert.ok(!isSelfReference(value), value + " is not a self reference");
    assert.ok(!isPreviousReference(value), value + " is not a previous reference");
  }
});

check("a bare 'browser' is a role, not an app", () => {
  for (const value of ["browser", "web browser", "default browser", "internet"]) {
    assert.ok(isGenericBrowserQuery(value), value);
  }
  assert.ok(!isGenericBrowserQuery("chrome"));
});

check("process image mapping is case-insensitive and extension tolerant", () => {
  assert.strictEqual(entryForProcess("Code").key, "vscode");
  assert.strictEqual(entryForProcess("CODE.EXE").key, "vscode");
  assert.strictEqual(entryForProcess("chrome").key, "chrome");
  assert.strictEqual(entryForProcess("explorer").key, "fileexplorer");
  assert.strictEqual(entryForProcess("electron"), null);
  assert.strictEqual(entryForProcess("some-random-process"), null);
  assert.strictEqual(normalizeProcessName("Code.exe"), "code");
});

check("image names must look like executables", () => {
  assert.ok(isImageNameSafe("Code.exe"));
  assert.ok(!isImageNameSafe("Code"));
  assert.ok(!isImageNameSafe("code.exe & calc.exe"));
  assert.ok(!isImageNameSafe("; rm -rf /"));
  assert.ok(!isImageNameSafe(""));
});

check("environment expansion never invents an unknown variable", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local", "ProgramFiles(x86)": "C:\\PF86" };
  assert.strictEqual(
    expandEnvPath("%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe", env),
    "C:\\Users\\Test\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"
  );
  assert.strictEqual(expandEnvPath("%ProgramFiles(x86)%\\x.exe", env), "C:\\PF86\\x.exe");
  assert.strictEqual(expandEnvPath("%NOT_SET%\\x.exe", env), "%NOT_SET%\\x.exe");
});

check("suggestions stay inside the allowlist", () => {
  const suggestions = suggestApps("photoshp");
  assert.ok(Array.isArray(suggestions));
  for (const entry of suggestions) assert.ok(APP_BY_KEY.has(entry.key));
});

console.log("\n==================================================");
console.log("  ALL " + passed + " APP ALLOWLIST CHECKS PASSED");
console.log("==================================================");
