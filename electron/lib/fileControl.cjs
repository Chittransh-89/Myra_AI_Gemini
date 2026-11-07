"use strict";

/**
 * Myra AI — file access controller (ELECTRON MAIN PROCESS ONLY).
 *
 * Security model
 * --------------
 *  - The renderer has NO filesystem access. It can only ask main to show the
 *    native picker (a user gesture) or read the current file context.
 *  - Myra may read a file ONLY when the user explicitly authorized it:
 *      * by choosing it in the native picker (manual or via action 'pick'), or
 *      * by approving a native confirmation (action 'authorize').
 *  - Authorization is per exact real path and lives in main memory for this
 *    session only. Nothing is persisted and no folder-wide grant exists.
 *  - Symlinks are resolved before the check, so a link cannot smuggle in a
 *    different file.
 *  - Sensitive paths (keys, .env, credential stores) are flagged, and they are
 *    NEVER readable without the user naming/approving that exact file.
 *  - File contents are never executed; only text is extracted.
 *
 * Context: opened documents stay in main memory (bounded), with one ACTIVE
 * document. Chunks are byte-budgeted so the signed completion that carries
 * them to Gemini always fits the 8 KB result cap.
 */

const path = require("path");
const fsp = require("fs").promises;

const {
  extractDocument,
  buildChunkResult,
  docBase,
  searchText,
  compareTexts,
  validateFilePath,
  extensionOf,
  isSensitivePath,
  deriveId,
  DEFAULT_CHUNK_CHARS,
  RESULT_JSON_BUDGET,
} = require("./fileReader.cjs");

const MAX_OPEN_DOCS = 12;
const MAX_PICK_FILES = 4;
const PICKER_WAIT_MS = 20000;
const MAX_COMPARE_FILES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => (process.platform === "win32" ? String(p).toLowerCase() : String(p));

function createFileControl({ audit = () => {}, log = () => {}, pickFiles, confirmPath, onState } = {}) {
  const authorized = new Set(); // normalized real paths the user approved
  const docs = new Map(); // id -> extracted document
  let activeId = null;
  let lastError = null;
  let status = "idle";

  // -- state ---------------------------------------------------------------

  function summary(doc) {
    return {
      id: doc.id,
      name: doc.name,
      path: doc.path,
      kind: doc.kind,
      extension: doc.extension || null,
      sizeBytes: doc.sizeBytes,
      charCount: doc.charCount,
      lineCount: doc.lineCount,
      encoding: doc.encoding || null,
      truncated: doc.truncated === true,
      sensitive: doc.sensitive === true,
      active: doc.id === activeId,
    };
  }

  function activeDoc() {
    return activeId ? docs.get(activeId) || null : null;
  }

  function getState() {
    const active = activeDoc();
    return {
      ok: true,
      status,
      active: active ? summary(active) : null,
      open: [...docs.values()].map(summary),
      lastError,
    };
  }

  function emit(nextStatus, error) {
    status = nextStatus;
    if (error !== undefined) lastError = error;
    try {
      if (typeof onState === "function") onState(getState());
    } catch {
      /* UI state must never break a tool call */
    }
  }

  function trimOpenDocs() {
    while (docs.size > MAX_OPEN_DOCS) {
      const oldest = docs.keys().next().value; // Map keeps insertion order
      if (oldest === activeId) break;
      docs.delete(oldest);
    }
  }

  // -- resolution ----------------------------------------------------------

  function findDoc(idOrName) {
    const raw = String(idOrName == null ? "" : idOrName).trim();
    if (!raw) return activeDoc();
    if (docs.has(raw)) return docs.get(raw);
    const wanted = raw.toLowerCase();
    for (const doc of docs.values()) {
      if (doc.name.toLowerCase() === wanted) return doc;
      if (doc.name.toLowerCase().replace(/\.[^.]+$/, "") === wanted) return doc;
    }
    return null;
  }

  async function resolveReal(filePath) {
    const validated = validateFilePath(filePath);
    if (!validated.ok) return { ok: false, error: validated.error };
    let real;
    try {
      real = await fsp.realpath(validated.path);
    } catch {
      return { ok: false, error: "fileNotFound", path: validated.path };
    }
    const st = await fsp.stat(real).catch(() => null);
    if (!st || !st.isFile()) return { ok: false, error: "notAFile", path: validated.path };
    return { ok: true, real, path: validated.path, sensitive: isSensitivePath(real) };
  }

  function isAuthorized(real) {
    return authorized.has(norm(real));
  }

  function notAuthorized(real, requestedPath) {
    return {
      ok: false,
      action: "read",
      error: "notAuthorized",
      name: path.basename(real),
      path: real,
      sensitive: isSensitivePath(real),
      requiresApproval: true,
      hint:
        "Myra has no permission to read this file yet. Ask the user for permission; after they agree, " +
        "call fileControl with action 'authorize' and the same path (a native Allow/Cancel prompt appears).",
    };
  }

  // -- reading -------------------------------------------------------------

  async function loadAuthorized(real, { action = "read", offset, maxChars } = {}) {
    emit("reading", null);
    const extracted = await extractDocument(real);
    if (!extracted.ok) {
      emit("error", extracted.error);
      return {
        ok: false,
        action,
        error: extracted.error,
        name: path.basename(real),
        path: real,
        detail: extracted.detail || null,
        hint: extracted.hint || null,
      };
    }

    const doc = extracted.doc;
    docs.set(doc.id, doc);
    activeId = doc.id;
    trimOpenDocs();
    emit("ready", null);
    audit("FILE_READ", { tool: "fileControl", ext: extensionOf(real) });
    return buildChunkResult(doc, action, offset, maxChars);
  }

  async function readPath(filePath, options = {}) {
    const resolved = await resolveReal(filePath);
    if (!resolved.ok) return { ok: false, action: options.action || "read", error: resolved.error, path: resolved.path || null };
    if (!isAuthorized(resolved.real)) return notAuthorized(resolved.real, resolved.path);
    return loadAuthorized(resolved.real, options);
  }

  async function authorize(args) {
    const resolved = await resolveReal(args.path);
    if (!resolved.ok) return { ok: false, action: "authorize", error: resolved.error, path: resolved.path || null };
    if (isAuthorized(resolved.real)) {
      return loadAuthorized(resolved.real, { action: "authorize", offset: args.offset, maxChars: args.maxChars });
    }

    let allowed = false;
    try {
      allowed = typeof confirmPath === "function" ? (await confirmPath(resolved.real)) === true : false;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      emit("idle", "notAuthorized");
      return {
        ok: false,
        action: "authorize",
        error: "notAuthorized",
        reason: "userDeclined",
        name: path.basename(resolved.real),
        path: resolved.real,
        hint: "The user did not approve reading this file. Do not try another way to read it.",
      };
    }

    authorized.add(norm(resolved.real));
    audit("FILE_AUTHORIZED", { tool: "fileControl", ext: extensionOf(resolved.real) });
    return loadAuthorized(resolved.real, { action: "authorize", offset: args.offset, maxChars: args.maxChars });
  }

  async function finishPick(selection, args = {}) {
    if (!selection || selection.canceled || !Array.isArray(selection.paths) || selection.paths.length === 0) {
      emit("idle", "pickerCanceled");
      return { ok: false, action: "pick", error: "pickerCanceled" };
    }

    const unique = [...new Set(selection.paths.map((p) => String(p)))].slice(0, MAX_PICK_FILES);
    const files = [];
    let firstReal = null;

    for (const candidate of unique) {
      const resolved = await resolveReal(candidate);
      if (!resolved.ok) {
        files.push({ name: path.basename(candidate), error: resolved.error });
        continue;
      }
      authorized.add(norm(resolved.real)); // the picker selection IS the consent
      if (!firstReal) firstReal = resolved.real;
      files.push({ name: path.basename(resolved.real), error: null });
    }

    if (!firstReal) {
      emit("error", "pickerSelectionUnreadable");
      return { ok: false, action: "pick", error: "pickerSelectionUnreadable", files };
    }

    audit("FILE_PICKED", { tool: "fileControl", count: unique.length });
    const loaded = await loadAuthorized(firstReal, {
      action: "pick",
      offset: args.offset,
      maxChars: args.maxChars,
    });
    if (!loaded.ok) return loaded;

    const result = { ...loaded, files, openCount: docs.size };
    if (unique.length > 1) {
      result.note =
        "Several files were authorized. Use action 'switch' (by name or id) to change the active file, " +
        "or action 'compare' to compare them.";
    }
    return result;
  }

  async function pick(args = {}) {
    if (typeof pickFiles !== "function") {
      return { ok: false, action: "pick", error: "pickerUnavailable" };
    }

    const pending = Promise.resolve()
      .then(() => pickFiles())
      .catch(() => ({ canceled: true, paths: [] }));

    const timedOut = Symbol("pickerTimeout");
    const selection = await Promise.race([pending, sleep(PICKER_WAIT_MS).then(() => timedOut)]);

    if (selection === timedOut) {
      // The dialog is still open. Do not block the tool call: finish reading in
      // the background so the context chip still updates for the user.
      pending.then((res) => finishPick(res, args)).catch(() => {});
      return {
        ok: true,
        action: "pick",
        pickerOpened: true,
        note:
          "The native file picker is open on the user's screen. After they choose a file it becomes the current " +
          "file; call action 'current' to read it (or wait for their next request).",
      };
    }

    return finishPick(selection, args);
  }

  async function current(args = {}) {
    const doc = activeDoc();
    if (!doc) return { ok: false, action: "current", error: "noOpenFile" };
    return buildChunkResult(doc, "current", args.offset, args.maxChars);
  }

  async function read(args = {}) {
    if (args.id) {
      const doc = findDoc(args.id);
      if (!doc) return { ok: false, action: "read", error: "unknownFileId" };
      activeId = doc.id;
      return buildChunkResult(doc, "read", args.offset, args.maxChars);
    }
    if (typeof args.path !== "string" || args.path.trim() === "") {
      return { ok: false, action: "read", error: "missingPath", hint: "Pass an absolute path, or use action 'current' for the open file." };
    }
    return readPath(args.path, { action: "read", offset: args.offset, maxChars: args.maxChars });
  }

  async function list() {
    const active = activeDoc();
    return {
      ok: true,
      action: "list",
      count: docs.size,
      activeId: active ? active.id : null,
      files: [...docs.values()].map(summary),
    };
  }

  async function switchDoc(args = {}) {
    const doc = findDoc(args.id || args.name || args.path);
    if (!doc) return { ok: false, action: "switch", error: "unknownFile" };
    activeId = doc.id;
    emit("ready", null);
    return buildChunkResult(doc, "switch", args.offset, args.maxChars);
  }

  async function search(args = {}) {
    let doc = null;
    if (args.id || args.path) {
      if (args.path) {
        const resolved = await resolveReal(args.path);
        if (!resolved.ok) return { ok: false, action: "search", error: resolved.error };
        if (!isAuthorized(resolved.real)) return notAuthorized(resolved.real, resolved.path);
        const existing = docs.get(deriveId(resolved.real));
        if (existing) doc = existing;
        else {
          const loaded = await loadAuthorized(resolved.real, { action: "search" });
          if (!loaded.ok) return loaded;
          doc = activeDoc();
        }
      } else {
        doc = findDoc(args.id);
      }
    } else {
      doc = activeDoc();
    }
    if (!doc) return { ok: false, action: "search", error: "noOpenFile" };

    const found = searchText(doc.text, args.query, args.maxMatches);
    if (!found.ok) return { ok: false, action: "search", error: found.error, name: doc.name };

    return {
      ok: true,
      action: "search",
      id: doc.id,
      name: doc.name,
      query: String(args.query),
      totalMatches: found.totalMatches,
      matches: found.matches,
      truncatedCount: found.truncatedCount === true,
      totalChars: doc.charCount,
      note:
        found.totalMatches === 0
          ? "No literal match. Try a shorter term, different casing is irrelevant, or read around an offset."
          : "Use action 'read' with an offset to see more context around a match line.",
    };
  }

  async function compare(args = {}) {
    const requested = Array.isArray(args.paths) ? args.paths : Array.isArray(args.ids) ? args.ids : [];
    const targets = requested
      .map((t) => (typeof t === "string" && t.indexOf("file_") === 0 ? null : t))
      .filter(Boolean);
    const ids = Array.isArray(args.ids) ? args.ids : [];

    const chosen = [];
    for (const p of targets) {
      chosen.push({ path: p });
      if (chosen.length >= MAX_COMPARE_FILES) break;
    }
    for (const id of ids) {
      const doc = findDoc(id);
      if (doc) chosen.push({ doc });
      if (chosen.length >= MAX_COMPARE_FILES) break;
    }
    if (chosen.length < 2) {
      return { ok: false, action: "compare", error: "needTwoFiles", hint: "Pass paths: [\"C:\\\\a.txt\", \"C:\\\\b.txt\"]." };
    }

    const loaded = [];
    for (const item of chosen) {
      if (item.doc) {
        loaded.push(item.doc);
        continue;
      }
      const resolved = await resolveReal(item.path);
      if (!resolved.ok) return { ok: false, action: "compare", error: resolved.error, path: resolved.path || null };
      if (!isAuthorized(resolved.real)) return notAuthorized(resolved.real, resolved.path);
      const extracted = await extractDocument(resolved.real);
      if (!extracted.ok) {
        return { ok: false, action: "compare", error: extracted.error, name: path.basename(resolved.real) };
      }
      docs.set(extracted.doc.id, extracted.doc);
      loaded.push(extracted.doc);
    }
    trimOpenDocs();

    const base = loaded.map((doc) => ({
      ...docBase(doc, "compare"),
      preview: doc.text.slice(0, 320),
    }));
    const diff = compareTexts(loaded[0].text, loaded[1].text);

    const payload = {
      ok: true,
      action: "compare",
      files: base.map(({ ok, action, path: filePath, charCount, lineCount, kind, name, preview, id }) => ({
        id,
        name,
        path: filePath,
        kind,
        charCount,
        lineCount,
        preview,
      })),
      diff,
      note: "Line-aligned comparison. Read either file with an offset for full detail; nothing is assumed.",
    };

    // Keep the payload inside the completion budget by trimming previews first.
    let guard = 0;
    while (JSON.stringify(payload).length > RESULT_JSON_BUDGET && guard++ < 12) {
      let trimmed = false;
      for (const file of payload.files) {
        if (file.preview.length > 80) {
          file.preview = file.preview.slice(0, Math.max(80, Math.floor(file.preview.length * 0.6)));
          trimmed = true;
        }
      }
      if (!trimmed && payload.diff.samples.length > 0) {
        payload.diff.samples = payload.diff.samples.slice(0, Math.max(0, payload.diff.samples.length - 1));
        trimmed = true;
      }
      if (!trimmed) break;
    }
    return payload;
  }

  function close(args = {}) {
    const doc = findDoc(args.id || args.name);
    if (!doc) return { ok: false, action: "close", error: "noOpenFile" };
    docs.delete(doc.id);
    if (activeId === doc.id) {
      const last = [...docs.keys()].pop() || null;
      activeId = last;
    }
    emit(docs.size ? "ready" : "idle", null);
    return { ok: true, action: "close", closed: doc.name, remaining: docs.size, active: activeDoc() ? summary(activeDoc()) : null };
  }

  function closeAll() {
    const count = docs.size;
    docs.clear();
    activeId = null;
    emit("idle", null);
    return { ok: true, action: "closeAll", closed: count };
  }

  // -- dispatch ------------------------------------------------------------

  async function run(rawArgs) {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    const action = String(args.action || "").trim();
    audit("FILE_ACTION", { tool: "fileControl", action: action || "?" });

    try {
      if (action === "pick") return await pick(args);
      if (action === "read") return await read(args);
      if (action === "authorize") return await authorize(args);
      if (action === "current") return await current(args);
      if (action === "list") return await list();
      if (action === "switch") return await switchDoc(args);
      if (action === "search") return await search(args);
      if (action === "compare") return await compare(args);
      if (action === "close") return close(args);
      if (action === "closeAll") return closeAll();
      return { ok: false, error: "unsupportedAction", action: action.slice(0, 40) };
    } catch (err) {
      const reason = String((err && err.code) || (err && err.message) || "fileError").slice(0, 120);
      log("fileControl error:", action, reason);
      emit("error", reason);
      return { ok: false, action: action || null, error: reason };
    }
  }

  return {
    run,
    getState,
    /** UI-triggered picker: returns ONLY the context state, never file content. */
    pickFromUi: async () => {
      await pick({});
      return getState();
    },
    closeFromUi: () => {
      closeAll();
      return getState();
    },
    /** Test/diagnostic helpers. */
    authorizedCount: () => authorized.size,
    openCount: () => docs.size,
    active: () => (activeDoc() ? summary(activeDoc()) : null),
  };
}

module.exports = {
  createFileControl,
  MAX_OPEN_DOCS,
  MAX_PICK_FILES,
  PICKER_WAIT_MS,
  DEFAULT_CHUNK_CHARS,
};
