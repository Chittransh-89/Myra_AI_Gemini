/**
 * Myra AI — read-only local project scanner.
 *
 * Security properties (all enforced here, not in the UI):
 *  - Only an explicitly approved root is scanned. In Electron runs the root
 *    must appear in the approval registry that the native folder picker writes
 *    (see electron/main.cjs); a typed path alone is not enough there.
 *  - Every candidate path is resolved and checked to stay inside the root.
 *  - Symlinks are never followed (files or directories).
 *  - Files are opened read-only. Nothing is written, renamed, moved or run.
 *  - Secret files are never read; text is redacted before leaving this module.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import {
  DEFAULT_SCAN_LIMITS,
  classifyFile,
  isBinaryBuffer,
  isExcludedDir,
  isInsideRoot,
  isTooBroadRoot,
  scoreFile,
  toPosix,
  type ScanLimits,
} from "./filter.js";
import { redactSecrets } from "./redact.js";
import { IntelligenceError, type ImportedProject, type ProjectFile, type ProjectNode } from "./types.js";

const MAX_TREE_NODES = 600;
const MAX_APPROVED_ROOT_FILE_BYTES = 64 * 1024;

export interface ScanOptions {
  limits?: Partial<ScanLimits>;
  approvedRootsFile?: string | null;
  /** Electron runs require picker approval; standalone loopback dev does not. */
  requireApproval: boolean;
}

function resolveLimits(partial?: Partial<ScanLimits>): ScanLimits {
  return { ...DEFAULT_SCAN_LIMITS, ...(partial ?? {}) };
}

/** Structural validation of a user-supplied root path. */
export function validateRootPath(raw: string): { ok: true; root: string } | { ok: false; error: string } {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "emptyPath" };
  if (text.length > 1000) return { ok: false, error: "pathTooLong" };
  if (text.includes("\u0000")) return { ok: false, error: "badPath" };
  if (/^\\\\[.?]\\/.test(text) || /^\\\\[^\\]/.test(text) || /^\/\//.test(text)) {
    return { ok: false, error: "unsupportedPath" };
  }
  if (!path.isAbsolute(text)) return { ok: false, error: "pathNotAbsolute" };
  const resolved = path.resolve(text);
  if (isTooBroadRoot(resolved, os.homedir())) return { ok: false, error: "rootTooBroad" };
  return { ok: true, root: resolved };
}

/** Read the roots the Electron main process approved via the native picker. */
export async function readApprovedRoots(file: string | null | undefined): Promise<string[]> {
  if (!file) return [];
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > MAX_APPROVED_ROOT_FILE_BYTES) return [];
    const parsed = JSON.parse(await fs.promises.readFile(file, "utf8"));
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.roots) ? parsed.roots : [];
    return list
      .map((entry: any) => (typeof entry === "string" ? entry : entry?.root))
      .filter((entry: unknown): entry is string => typeof entry === "string" && entry.length > 0)
      .map((entry: string) => path.resolve(entry));
  } catch {
    return [];
  }
}

export async function isRootApproved(
  root: string,
  approvedRootsFile: string | null | undefined
): Promise<boolean> {
  const approved = await readApprovedRoots(approvedRootsFile);
  return approved.some((approvedRoot) => isInsideRoot(approvedRoot, root));
}

function projectIdFor(root: string): string {
  return "proj_" + crypto.createHash("sha256").update("local:" + path.resolve(root)).digest("hex").slice(0, 16);
}

function decodeText(buf: Buffer): string | null {
  if (isBinaryBuffer(buf)) return null;
  let body = buf;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) body = buf.subarray(3);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    // A latin1 fallback keeps a partially-broken source file useful, but only
    // if it still looks like text.
    text = body.toString("latin1");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export async function scanLocalProject(rawRoot: string, options: ScanOptions): Promise<ImportedProject> {
  const limits = resolveLimits(options.limits);
  const validated = validateRootPath(rawRoot);
  if ("error" in validated) {
    throw new IntelligenceError("invalidRoot", `Project folder rejected (${validated.error}).`, 400);
  }

  let rootReal: string;
  try {
    rootReal = await fs.promises.realpath(validated.root);
    const stat = await fs.promises.stat(rootReal);
    if (!stat.isDirectory()) {
      throw new IntelligenceError("notADirectory", "The selected path is not a folder.", 400);
    }
  } catch (err) {
    if (err instanceof IntelligenceError) throw err;
    throw new IntelligenceError("folderNotFound", "That folder does not exist or cannot be opened.", 404);
  }

  if (options.requireApproval) {
    const approved = await isRootApproved(rootReal, options.approvedRootsFile);
    if (!approved) {
      throw new IntelligenceError(
        "folderNotApproved",
        "This folder was not approved through the folder picker. Open Interview Mode and choose the folder with the picker.",
        403
      );
    }
  }

  const warnings: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const candidates: { rel: string; absolute: string; size: number; real: string }[] = [];
  const tree: ProjectNode[] = [];
  let symlinksSkipped = 0;
  let visited = 0;

  const stack: string[] = [rootReal];
  while (stack.length > 0 && visited < 20000) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      skipped.push({ path: toPosix(path.relative(rootReal, dir)), reason: "unreadableDirectory" });
      continue;
    }
    visited += 1;

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const rel = toPosix(path.relative(rootReal, absolute));
      if (!rel || rel.startsWith("..")) continue;

      if (entry.isSymbolicLink()) {
        symlinksSkipped += 1;
        continue;
      }

      if (entry.isDirectory()) {
        if (isExcludedDir(entry.name)) {
          skipped.push({ path: rel + "/", reason: "excludedDirectory" });
          continue;
        }
        if (tree.length < MAX_TREE_NODES) tree.push({ path: rel + "/", type: "dir" });
        stack.push(absolute);
        continue;
      }

      if (!entry.isFile()) continue;

      const classification = classifyFile(rel, 0, limits);
      // Size is checked again after stat; classifyFile with 0 keeps the reason
      // consistent for name-based exclusions.
      if (!classification.include) {
        skipped.push({ path: rel, reason: classification.reason ?? "excluded" });
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(absolute);
      } catch {
        skipped.push({ path: rel, reason: "unreadable" });
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > limits.maxFileBytes) {
        skipped.push({ path: rel, reason: "tooLarge" });
        continue;
      }

      let realFile: string;
      try {
        realFile = await fs.promises.realpath(absolute);
      } catch {
        skipped.push({ path: rel, reason: "unreadable" });
        continue;
      }
      if (!isInsideRoot(rootReal, realFile)) {
        skipped.push({ path: rel, reason: "outsideRoot" });
        continue;
      }

      candidates.push({ rel, absolute, size: stat.size, real: realFile });
      if (tree.length < MAX_TREE_NODES) tree.push({ path: rel, type: "file", size: stat.size });
    }
  }

  if (symlinksSkipped > 0) {
    warnings.push(`${symlinksSkipped} symlink(s) were skipped — Myra never follows links outside the project.`);
  }
  if (visited >= 20000) warnings.push("Folder traversal hit the directory limit; only the first 20,000 folders were inspected.");

  candidates.sort((a, b) => scoreFile(b.rel) - scoreFile(a.rel) || a.rel.localeCompare(b.rel));

  const files: ProjectFile[] = [];
  let totalChars = 0;
  let totalBytes = 0;
  let totalRedactions = 0;

  for (const candidate of candidates) {
    if (files.length >= limits.maxFiles) {
      skipped.push({ path: candidate.rel, reason: "fileBudgetReached" });
      continue;
    }
    if (totalChars >= limits.maxTotalChars) {
      skipped.push({ path: candidate.rel, reason: "contextBudgetReached" });
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(candidate.real);
    } catch {
      skipped.push({ path: candidate.rel, reason: "unreadable" });
      continue;
    }
    if (buffer.length > limits.maxFileBytes) {
      skipped.push({ path: candidate.rel, reason: "tooLarge" });
      continue;
    }

    const decoded = decodeText(buffer);
    if (decoded === null) {
      skipped.push({ path: candidate.rel, reason: "binary" });
      continue;
    }

    const remaining = limits.maxTotalChars - totalChars;
    const truncated = decoded.length > remaining;
    const slice = truncated ? decoded.slice(0, remaining) : decoded;
    const redacted = redactSecrets(slice);

    files.push({
      path: candidate.rel,
      text: redacted.text,
      bytes: buffer.length,
      lines: redacted.text.split("\n").length,
      redactions: redacted.redactions,
      truncated,
    });
    totalChars += redacted.text.length;
    totalBytes += buffer.length;
    totalRedactions += redacted.redactions;
  }

  if (files.length === 0) {
    throw new IntelligenceError(
      "noReadableFiles",
      "No readable source files were found in that folder after filtering.",
      422
    );
  }

  return {
    projectId: projectIdFor(rootReal),
    name: path.basename(rootReal),
    source: { kind: "local", root: rootReal, name: path.basename(rootReal) },
    files,
    tree,
    warnings,
    skipped: skipped.slice(0, 300),
    stats: {
      files: files.length,
      bytes: totalBytes,
      chars: totalChars,
      redactions: totalRedactions,
      skipped: skipped.length,
    },
    importedAt: new Date().toISOString(),
  };
}
