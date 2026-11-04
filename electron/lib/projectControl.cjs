"use strict";

/**
 * Myra AI — VS Code project builder (Electron MAIN process only).
 *
 * Everything happens in main: the renderer never receives fs, and no shell is
 * used anywhere in this module. Only `fs` calls plus fixed, read-only probes.
 *
 * Safety model (mirrors the file-approval rules used elsewhere in Myra):
 *  1. DETECT  — find the active VS Code workspace from VS Code's OWN state files.
 *  2. REFERENCE — optionally scan a reference folder (never written to).
 *  3. PLAN    — validate every path, compute what exists, and store the plan in
 *                main memory. NOTHING is created. Returns a one-time planId.
 *  4. APPLY   — requires that planId; the plan is bound to the exact root real
 *                path, the exact entry list and the exact content bytes. Files
 *                that already exist are only written when the user separately
 *                confirmed overwriting (confirmOverwrite: true).
 *
 * Path traversal is rejected structurally (absolute paths, drive letters, UNC,
 * "..", ADS colons, reserved device names) and again at write time by checking
 * containment inside the realpath'd root.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const MAX_ENTRIES = 200;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_DEPTH = 8;
const PLAN_TTL_MS = 10 * 60 * 1000; // 10 minutes to say "yes"
const MAX_PLANS = 6;
const RESULT_LIST_CAP = 80;

const REF_MAX_ENTRIES = 400;
const REF_MAX_DEPTH = 5;
const REF_IGNORED = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "__pycache__",
  ".venv", "venv", "env", ".idea", ".vscode", "target", "bin", "obj",
  ".freebuff", ".pytest_cache", ".mypy_cache", "coverage",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Path policy (pure, unit-testable)
// ---------------------------------------------------------------------------

function isPathInside(rootReal, target) {
  const rel = path.relative(rootReal, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Validate a user/model supplied relative path. Rejects traversal and escapes. */
function normalizeRelative(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return { ok: false, error: "emptyPath" };
  if (text.length > 400) return { ok: false, error: "pathTooLong" };
  if (text.indexOf("\u0000") >= 0) return { ok: false, error: "badPath" };
  if (/^[a-zA-Z]:/.test(text)) return { ok: false, error: "absolutePath" };
  if (text.startsWith("\\\\") || text.startsWith("//") || text.startsWith("/") || text.startsWith("\\")) {
    return { ok: false, error: "absolutePath" };
  }
  if (text.indexOf(":") >= 0) return { ok: false, error: "badPath" }; // NTFS alternate data stream

  const parts = text.split(/[\\/]+/).filter((p) => p.length > 0);
  if (!parts.length) return { ok: false, error: "emptyPath" };
  if (parts.length > MAX_DEPTH) return { ok: false, error: "tooDeep" };
  for (const part of parts) {
    if (part === "." || part === "..") return { ok: false, error: "pathTraversal" };
    if (/[<>"|?*]/.test(part)) return { ok: false, error: "badPath" };
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)) return { ok: false, error: "badPath" };
    if (part !== part.trim() || part.endsWith(".")) return { ok: false, error: "badPath" };
  }
  return { ok: true, rel: parts.join(path.sep), parts };
}

/** Infer a node type when the model omits one. */
function inferType(raw) {
  if (raw.type === "dir" || raw.type === "directory" || raw.type === "folder") return "dir";
  if (raw.type === "file") return "file";
  if (typeof raw.content === "string") return "file";
  const p = String(raw.path || "");
  if (p.endsWith("/") || p.endsWith("\\")) return "dir";
  const last = p.split(/[\\/]+/).filter(Boolean).pop() || "";
  return last.indexOf(".") === -1 ? "dir" : "file";
}

// ---------------------------------------------------------------------------
// VS Code workspace detection (read-only; VS Code's own state files)
// ---------------------------------------------------------------------------

function fileUriToPath(uri) {
  if (typeof uri !== "string") return null;
  if (uri.toLowerCase().indexOf("file://") !== 0) return null;
  let p = uri.replace(/^file:\/\/\/?/i, "");
  try {
    p = decodeURIComponent(p);
  } catch {}
  if (process.platform === "win32") {
    p = p.replace(/^\/([a-zA-Z]:)/, "$1");
    p = p.replace(/\//g, "\\");
  }
  return p || null;
}

function vscodeStateRoots() {
  const appData = process.env.APPDATA;
  if (!appData) return [];
  return [
    path.join(appData, "Code"),
    path.join(appData, "Code - Insiders"),
  ];
}

async function isDirectory(target) {
  try {
    const st = await fsp.stat(target);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function unsafePathError() {
  const err = new Error("unsafePath");
  err.code = "unsafePath";
  return err;
}

/**
 * Create a directory one component at a time, refusing to traverse links,
 * junctions, or files. `mkdir({recursive:true})` would otherwise follow an
 * already-present link before the post-write containment check gets a chance
 * to run. This is deliberately used immediately before every write.
 */
async function ensureSafeDirectory(rootReal, targetDir, createdDirs) {
  if (!isPathInside(rootReal, targetDir)) throw unsafePathError();
  const relative = path.relative(rootReal, targetDir);
  if (!relative) return;

  let current = rootReal;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    let st;
    try {
      st = await fsp.lstat(current);
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
      await fsp.mkdir(current);
      st = await fsp.lstat(current);
      if (createdDirs) createdDirs.push(path.relative(rootReal, current));
    }

    if (!st.isDirectory() || st.isSymbolicLink()) throw unsafePathError();
    // On Windows, junctions are not consistently reported as symbolic links.
    // Resolving every existing component closes that escape hatch as well.
    const real = await fsp.realpath(current);
    if (!isPathInside(rootReal, real)) throw unsafePathError();
  }
}

/** The workspace VS Code wrote to most recently — i.e. the one in use. */
async function detectFromWorkspaceStorage() {
  const found = [];
  for (const root of vscodeStateRoots()) {
    const base = path.join(root, "User", "workspaceStorage");
    let dirs = [];
    try {
      dirs = await fsp.readdir(base);
    } catch {
      continue;
    }
    for (const d of dirs) {
      const wf = path.join(base, d, "workspace.json");
      try {
        const st = await fsp.stat(wf);
        found.push({ wf, mtime: st.mtimeMs });
      } catch {}
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);

  for (const cand of found.slice(0, 8)) {
    try {
      const json = JSON.parse(await fsp.readFile(cand.wf, "utf8"));
      let target = fileUriToPath(json.folder || json.workspace);
      if (!target) continue;
      if (!(await isDirectory(target))) {
        // Handle .code-workspace files
        try {
          const st = await fsp.stat(target);
          if (st.isFile() && target.endsWith(".code-workspace")) {
            const wsData = JSON.parse(await fsp.readFile(target, "utf8"));
            if (Array.isArray(wsData.folders) && wsData.folders.length > 0) {
              const sub = wsData.folders[0].path;
              const resolved = path.isAbsolute(sub) ? sub : path.resolve(path.dirname(target), sub);
              if (await isDirectory(resolved)) {
                target = resolved;
              }
            }
          }
        } catch {}
      }
      if (!target || !(await isDirectory(target))) continue;
      return {
        root: await fsp.realpath(target),
        name: path.basename(target),
        source: "vscode-workspace-storage",
        lastUsedAgoSeconds: Math.max(0, Math.round((Date.now() - cand.mtime) / 1000)),
      };
    } catch {}
  }
  return null;
}

/** Fallback: the last active window VS Code recorded in global storage. */
async function detectFromGlobalStorage() {
  for (const root of vscodeStateRoots()) {
    const file = path.join(root, "User", "globalStorage", "storage.json");
    try {
      const json = JSON.parse(await fsp.readFile(file, "utf8"));
      const last = (json.windowsState && json.windowsState.lastActiveWindow) || null;
      let target = last ? fileUriToPath(last.folder || last.workspace) : null;
      if (!target) continue;
      if (!(await isDirectory(target))) {
        try {
          const st = await fsp.stat(target);
          if (st.isFile() && target.endsWith(".code-workspace")) {
            const wsData = JSON.parse(await fsp.readFile(target, "utf8"));
            if (Array.isArray(wsData.folders) && wsData.folders.length > 0) {
              const sub = wsData.folders[0].path;
              const resolved = path.isAbsolute(sub) ? sub : path.resolve(path.dirname(target), sub);
              if (await isDirectory(resolved)) target = resolved;
            }
          }
        } catch {}
      }
      if (!target || !(await isDirectory(target))) continue;
      return {
        root: await fsp.realpath(target),
        name: path.basename(target),
        source: "vscode-global-storage",
      };
    } catch {}
  }
  return null;
}

async function isVscodeRunning() {
  if (process.platform !== "win32") return false;
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };
    const timer = setTimeout(() => done(false), 2200);

    const { execFile } = require("child_process");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Name Code -ErrorAction SilentlyContinue).Count"],
      { timeout: 1800, windowsHide: true },
      (err, stdout) => {
        if (!err) {
          clearTimeout(timer);
          const count = parseInt(String(stdout || "").trim(), 10);
          return done(!isNaN(count) && count > 0);
        }
        execFile(
          "tasklist",
          ["/FI", "IMAGENAME eq Code.exe", "/NH"],
          { timeout: 1800, windowsHide: true },
          (tErr, tStdout) => {
            clearTimeout(timer);
            done(!tErr && String(tStdout || "").toLowerCase().indexOf("code.exe") >= 0);
          }
        );
      }
    );
  });
}

function generateAsciiTree(entries, projectName = "") {
  const root = { name: projectName || "project", isDir: true, children: new Map() };

  for (const entry of entries) {
    const parts = entry.parts || entry.rel.split(/[\\/]+/).filter(Boolean);
    let curr = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const isDir = isLast ? entry.type === "dir" : true;
      if (!curr.children.has(part)) {
        curr.children.set(part, { name: part, isDir, children: new Map() });
      }
      curr = curr.children.get(part);
    }
  }

  const lines = [root.name + "/"];
  function render(node, prefix = "") {
    const items = Array.from(node.children.values());
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isLast = i === items.length - 1;
      const branch = isLast ? "└── " : "├── ";
      const suffix = item.isDir ? "/" : "";
      lines.push(prefix + branch + item.name + suffix);
      if (item.children.size > 0) {
        const nextPrefix = prefix + (isLast ? "    " : "│   ");
        render(item, nextPrefix);
      }
    }
  }
  render(root);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Reference scan
// ---------------------------------------------------------------------------

async function scanTree(rootDir, maxEntries, maxDepth) {
  const entries = [];
  let truncated = false;

  async function walk(dir, depth, relBase) {
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const item of items) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      if (REF_IGNORED.has(item.name.toLowerCase())) continue;
      if (item.isSymbolicLink()) continue; // never follow links out of the folder
      const rel = relBase ? relBase + "/" + item.name : item.name;
      if (item.isDirectory()) {
        entries.push({ type: "dir", path: rel });
        if (depth < maxDepth) await walk(path.join(dir, item.name), depth + 1, rel);
        else truncated = true;
      } else if (item.isFile()) {
        entries.push({ type: "file", path: rel });
      }
    }
  }

  await walk(rootDir, 0, "");
  return { entries, truncated };
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

function createProjectControl({ audit, log, pickFolder } = {}) {
  const record = typeof audit === "function" ? audit : () => {};
  const emit = typeof log === "function" ? log : () => {};
  const plans = new Map();
  let lastReference = null; // remembered for the model's next plan

  function prunePlans() {
    const now = Date.now();
    for (const [id, p] of plans) {
      if (p.expiresAt < now) plans.delete(id);
    }
    while (plans.size >= MAX_PLANS) {
      const oldest = plans.keys().next().value;
      if (oldest === undefined) break;
      plans.delete(oldest);
    }
  }

  // -- 1. detect ------------------------------------------------------------
  async function detect() {
    try {
      const [running, hitCandidate] = await Promise.all([
        isVscodeRunning(),
        (async () => {
          const fromStorage = await detectFromWorkspaceStorage();
          if (fromStorage) return fromStorage;
          const fromGlobal = await detectFromGlobalStorage();
          if (fromGlobal) return fromGlobal;
          if (process.env.VSCODE_WORKSPACE_FOLDER && (await isDirectory(process.env.VSCODE_WORKSPACE_FOLDER))) {
            const root = await fsp.realpath(process.env.VSCODE_WORKSPACE_FOLDER);
            return { root, name: path.basename(root), source: "env-vscode-workspace" };
          }
          const cwd = process.cwd();
          if (await isDirectory(path.join(cwd, ".vscode"))) {
            const root = await fsp.realpath(cwd);
            return { root, name: path.basename(root), source: "cwd-vscode-marker" };
          }
          return null;
        })(),
      ]);

      const hit = hitCandidate;
      if (!hit) {
        return {
          ok: false,
          active: running,
          vscodeRunning: running,
          error: "noActiveProject",
          detail: "No VS Code workspace found. Ask the user for the project folder path.",
        };
      }
      return {
        ok: true,
        active: running,
        vscodeRunning: running,
        root: hit.root,
        name: hit.name,
        source: hit.source,
        lastUsedAgoSeconds: hit.lastUsedAgoSeconds === undefined ? null : hit.lastUsedAgoSeconds,
        note: running ? "VS Code is running." : "VS Code does not appear to be running; this is the last used workspace.",
      };
    } catch (err) {
      emit("VS Code detection failed:", err && err.message);
      return { ok: false, error: "detectFailed" };
    }
  }

  // -- 2/3. reference folder ------------------------------------------------
  async function reference(args) {
    let folder = typeof (args && args.path) === "string" ? args.path.trim() : "";

    if (!folder) {
      if (typeof pickFolder !== "function") {
        return { ok: false, error: "folderPickerUnavailable", detail: "Give me the reference folder path." };
      }
      let picked;
      try {
        picked = await pickFolder();
      } catch {
        return { ok: false, error: "folderPickerFailed" };
      }
      if (!picked || picked.canceled || !picked.path) {
        return { ok: false, canceled: true, error: "canceled" };
      }
      folder = picked.path;
    }

    try {
      if (!(await isDirectory(folder))) return { ok: false, error: "notADirectory", path: folder };
      const rootReal = await fsp.realpath(folder);
      const scan = await scanTree(rootReal, REF_MAX_ENTRIES, REF_MAX_DEPTH);
      lastReference = { root: rootReal, entries: scan.entries.slice(0, REF_MAX_ENTRIES) };
      record("PROJECT_REFERENCE_SCANNED", { tool: "projectControl" });
      return {
        ok: true,
        root: rootReal,
        dirs: scan.entries.filter((e) => e.type === "dir").length,
        files: scan.entries.filter((e) => e.type === "file").length,
        truncated: scan.truncated,
        entries: scan.entries.slice(0, RESULT_LIST_CAP).map((e) => (e.type === "dir" ? e.path + "/" : e.path)),
        note: "Reference scanned. Nothing was read besides names/structure, and nothing will be written there.",
      };
    } catch (err) {
      emit("Reference scan failed:", err && err.message);
      return { ok: false, error: "referenceFailed" };
    }
  }

  // -- 4/5. plan ------------------------------------------------------------
  async function plan(args) {
    let structure = args && args.structure;
    if (typeof structure === "string") {
      try {
        structure = JSON.parse(structure);
      } catch {}
    }
    if (!Array.isArray(structure) || structure.length === 0) {
      return { ok: false, error: "emptyStructure" };
    }
    if (structure.length > MAX_ENTRIES) return { ok: false, error: "tooManyEntries" };

    // Resolve the root: explicit path, else the active VS Code project.
    let rootArg = typeof (args && args.root) === "string" ? args.root.trim() : "";
    let rootReal;
    let rootName;
    if (!rootArg) {
      const det = await detect();
      if (!det.ok) return { ok: false, error: det.error || "noActiveProject", detail: det.detail };
      rootReal = det.root;
      rootName = det.name;
    } else {
      try {
        if (!(await isDirectory(rootArg))) return { ok: false, error: "rootNotADirectory" };
        rootReal = await fsp.realpath(rootArg);
        rootName = path.basename(rootReal);
      } catch {
        return { ok: false, error: "rootUnavailable" };
      }
    }

    const seen = new Map();
    const normalized = [];
    let totalBytes = 0;

    for (const raw of structure) {
      const item = typeof raw === "string" ? { path: raw } : raw;
      if (!item || typeof item !== "object") return { ok: false, error: "malformedEntry" };
      const norm = normalizeRelative(item.path);
      if (!norm.ok) return { ok: false, error: norm.error, path: String(item.path || "") };

      const key = norm.rel.toLowerCase();
      if (seen.has(key)) return { ok: false, error: "duplicatePath", path: norm.rel };

      const type = inferType(item);
      let content = "";
      if (type === "file") {
        if (item.content !== undefined && item.content !== null && typeof item.content !== "string") {
          return { ok: false, error: "contentNotText", path: norm.rel };
        }
        content = typeof item.content === "string" ? item.content : "";
        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > MAX_FILE_BYTES) return { ok: false, error: "fileTooLarge", path: norm.rel };
        totalBytes += bytes;
        if (totalBytes > MAX_TOTAL_BYTES) return { ok: false, error: "taskTooLarge" };
      }

      const abs = path.resolve(rootReal, norm.rel);
      if (!isPathInside(rootReal, abs)) return { ok: false, error: "pathEscapesRoot", path: norm.rel };

      seen.set(key, { rel: norm.rel, abs, type, content, parts: norm.parts });
      normalized.push(seen.get(key));
    }

    // A path listed as a file can never be an ancestor of another entry.
    const fileKeys = new Set(normalized.filter((e) => e.type === "file").map((e) => e.rel.toLowerCase()));
    for (const entry of normalized) {
      let prefix = "";
      for (let i = 0; i < entry.parts.length - 1; i++) {
        prefix = prefix ? prefix + path.sep + entry.parts[i] : entry.parts[i];
        if (fileKeys.has(prefix.toLowerCase())) {
          return { ok: false, error: "fileUsedAsFolder", path: prefix };
        }
      }
    }

    // What already exists on disk?
    const overwrites = [];
    const dirExists = [];
    const blocked = [];
    for (const entry of normalized) {
      let st = null;
      try {
        st = await fsp.lstat(entry.abs);
      } catch {}
      if (!st) continue;
      if (entry.type === "dir") {
        if (st.isDirectory()) dirExists.push(entry.rel);
        else blocked.push({ path: entry.rel, reason: "existsAsFile" });
      } else if (st.isDirectory()) {
        blocked.push({ path: entry.rel, reason: "existsAsFolder" });
      } else {
        overwrites.push(entry.rel);
      }
    }

    // Dirs shallow-first so parents are created before children.
    normalized.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.parts.length - b.parts.length;
    });

    const planId = crypto.randomBytes(16).toString("hex");
    const digest = crypto
      .createHash("sha256")
      .update(rootReal.toLowerCase() + "\u0000")
      .update(normalized.map((e) => e.type + ":" + e.rel + ":" + crypto.createHash("sha256").update(e.content).digest("hex")).join("\u0000"))
      .digest("hex");

    prunePlans();
    plans.set(planId, {
      rootReal,
      entries: normalized,
      overwrites,
      digest,
      used: false,
      expiresAt: Date.now() + PLAN_TTL_MS,
      request: String((args && args.request) || "").slice(0, 200),
    });

    record("PROJECT_PLAN_CREATED", { tool: "projectControl" });

    const listed = normalized.map((e) => (e.type === "dir" ? e.rel + path.sep : e.rel));
    const tree = generateAsciiTree(normalized, rootName);
    const summary = `Proposed structure with ${normalized.filter((e) => e.type === "dir").length} folder(s) and ${normalized.filter((e) => e.type === "file").length} file(s) in ${rootName}.`;

    return {
      ok: true,
      planId,
      root: rootReal,
      projectName: rootName,
      dirs: normalized.filter((e) => e.type === "dir").length,
      files: normalized.filter((e) => e.type === "file").length,
      bytes: totalBytes,
      paths: listed.slice(0, RESULT_LIST_CAP),
      tree,
      summary,
      entries: normalized.slice(0, RESULT_LIST_CAP).map((e) => ({
        path: e.rel,
        type: e.type,
        bytes: Buffer.byteLength(e.content || "", "utf8"),
      })),
      truncated: listed.length > RESULT_LIST_CAP,
      overwrites: overwrites.slice(0, 10),
      blocked: blocked.slice(0, 10),
      requiresConfirmation: true,
      requiresOverwriteConfirmation: overwrites.length > 0,
      expiresInSeconds: Math.round(PLAN_TTL_MS / 1000),
      detail:
        "Nothing has been created. Read this list to the user, ask for an explicit yes, then call apply with this planId." +
        (overwrites.length ? " Some files already exist and need confirmOverwrite:true after telling the user." : ""),
    };
  }

  // -- 6..11. apply ---------------------------------------------------------
  async function apply(args) {
    const planId = String((args && args.planId) || "").trim();
    if (!planId) return { ok: false, error: "missingPlanId" };
    prunePlans();

    const stored = plans.get(planId);
    if (!stored) return { ok: false, error: "unknownPlan" };
    if (stored.used) return { ok: false, error: "planAlreadyUsed" };
    if (stored.expiresAt < Date.now()) {
      plans.delete(planId);
      return { ok: false, error: "planExpired" };
    }

    let rootReal;
    try {
      rootReal = await fsp.realpath(stored.rootReal);
    } catch {
      return { ok: false, error: "rootUnavailable" };
    }
    if (rootReal.toLowerCase() !== stored.rootReal.toLowerCase()) {
      plans.delete(planId);
      return { ok: false, error: "rootChanged" };
    }

    const overwriteApproved = args && (args.confirmOverwrite === true || args.confirmOverwrite === "true");
    if (stored.overwrites.length && !overwriteApproved) {
      record("PROJECT_APPLY_DENIED", { tool: "projectControl", reason: "overwriteNotConfirmed" });
      return {
        ok: false,
        error: "overwriteNotConfirmed",
        planId,
        overwrites: stored.overwrites.slice(0, 10),
        detail: "These files already exist. Ask the user, then call apply again with confirmOverwrite:true.",
      };
    }

    stored.used = true; // single use, consumed before any write

    const createdDirs = [];
    const createdFiles = [];
    const overwrittenFiles = [];
    const skipped = [];
    const failed = [];
    const allowOverwrite = new Set(stored.overwrites.map((rel) => rel.toLowerCase()));

    for (const entry of stored.entries) {
      const abs = path.resolve(rootReal, entry.rel);
      if (!isPathInside(rootReal, abs)) {
        failed.push({ path: entry.rel, error: "pathEscapesRoot" });
        continue;
      }

      try {
        if (entry.type === "dir") {
          await ensureSafeDirectory(rootReal, abs, createdDirs);
          continue;
        }

        await ensureSafeDirectory(rootReal, path.dirname(abs), createdDirs);

        let existed = false;
        try {
          const st = await fsp.lstat(abs);
          existed = true;
          if (st.isDirectory()) {
            failed.push({ path: entry.rel, error: "existsAsFolder" });
            continue;
          }
          if (st.isSymbolicLink()) {
            failed.push({ path: entry.rel, error: "unsafePath" });
            continue;
          }
        } catch {}

        if (existed && !allowOverwrite.has(entry.rel.toLowerCase())) {
          skipped.push(entry.rel);
          continue;
        }

        await fsp.writeFile(abs, entry.content, { encoding: "utf8", flag: existed ? "w" : "wx" });
        if (existed) overwrittenFiles.push(entry.rel);
        else createdFiles.push(entry.rel);

        // Final containment check on the real target (symlink/junction escape).
        const real = await fsp.realpath(abs);
        if (!isPathInside(rootReal, real)) {
          failed.push({ path: entry.rel, error: "escapedRoot" });
        }
      } catch (err) {
        const code = (err && err.code) || "writeFailed";
        failed.push({ path: entry.rel, error: code === "EEXIST" ? "alreadyExists" : String(code) });
      }
    }

    record(failed.length ? "PROJECT_APPLY_PARTIAL" : "PROJECT_APPLY_OK", { tool: "projectControl" });

    const summary =
      failed.length === 0
        ? `Created ${createdDirs.length} folder(s) and ${createdFiles.length} file(s)` +
          (overwrittenFiles.length ? `, modified ${overwrittenFiles.length} file(s)` : "") +
          "."
        : `Partial apply: Created ${createdFiles.length} file(s), ${failed.length} failed.`;

    return {
      ok: failed.length === 0,
      root: rootReal,
      createdDirs: createdDirs.slice(0, RESULT_LIST_CAP),
      createdFiles: createdFiles.slice(0, RESULT_LIST_CAP),
      overwrittenFiles: overwrittenFiles.slice(0, RESULT_LIST_CAP),
      skipped: skipped.slice(0, RESULT_LIST_CAP),
      failed: failed.slice(0, 20),
      counts: {
        createdDirs: createdDirs.length,
        createdFiles: createdFiles.length,
        overwrittenFiles: overwrittenFiles.length,
        skipped: skipped.length,
        failed: failed.length,
      },
      summary,
      detail:
        failed.length === 0
          ? "Created " + createdDirs.length + " folder(s) and " + createdFiles.length + " file(s)" +
            (overwrittenFiles.length ? ", overwrote " + overwrittenFiles.length : "") + "."
          : "Some entries failed — report them honestly.",
    };
  }

  // -- 12. write into an existing file with its own approval ----------------
  async function edit(args) {
    const rawPath = args && args.path;
    const content = args && args.content;
    if (typeof content !== "string") return { ok: false, error: "missingContent" };
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) return { ok: false, error: "fileTooLarge" };

    const planned = await plan({
      root: args && args.root,
      request: "edit " + String(rawPath || ""),
      structure: [{ path: rawPath, type: "file", content }],
    });
    if (!planned.ok) return { ok: false, error: planned.error, path: planned.path };
    const overwriteApproved = args && (args.confirmOverwrite === true || args.confirmOverwrite === "true");
    const applied = await apply({ planId: planned.planId, confirmOverwrite: overwriteApproved });
    if (!applied.ok && applied.error === "overwriteNotConfirmed") {
      return { ...applied, planId: planned.planId };
    }
    return applied;
  }

  return {
    detect,
    reference,
    plan,
    apply,
    edit,
    plansCount: () => plans.size,
    lastReference: () => lastReference,
    getPlan: (id) => plans.get(id) || null,
  };
}

module.exports = {
  createProjectControl,
  normalizeRelative,
  isPathInside,
  fileUriToPath,
  inferType,
  generateAsciiTree,
  PLAN_TTL_MS,
};
