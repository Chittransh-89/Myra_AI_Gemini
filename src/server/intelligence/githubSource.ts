/**
 * Myra AI — public GitHub repository importer.
 *
 * Uses the GitHub REST API for metadata + the recursive git tree, then the raw
 * content host for file bodies. Public repositories only: no OAuth, no PATs,
 * no write access, no cloning and nothing is ever executed.
 *
 * Failures are reported as IntelligenceError with a stable code so the UI can
 * explain rate limits, a missing repo, or a private repo honestly.
 */

import {
  DEFAULT_SCAN_LIMITS,
  classifyFile,
  isBinaryBuffer,
  isInsideRoot,
  scoreFile,
  type ScanLimits,
} from "./filter.js";
import { redactSecrets } from "./redact.js";
import {
  IntelligenceError,
  type ImportedProject,
  type ProjectFile,
  type ProjectNode,
} from "./types.js";

const API_BASE = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUESTS = 220;
const MAX_TREE_ENTRIES = 20_000;
const MAX_TREE_NODES = 600;

export interface GitHubRef {
  owner: string;
  repo: string;
}

export interface GitHubImportOptions {
  limits?: Partial<ScanLimits>;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  rawBase?: string;
}

interface GitHubRequestState {
  fetchImpl: typeof fetch;
  apiBase: string;
  requests: number;
  warnings: string[];
}

/** Parse and validate a public GitHub repository URL. */
export function parseGitHubUrl(raw: string): { ok: true; ref: GitHubRef; url: string } | { ok: false; error: string } {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "emptyUrl" };
  if (text.length > 500) return { ok: false, error: "urlTooLong" };

  let url: URL;
  try {
    url = new URL(text.startsWith("http") ? text : `https://${text}`);
  } catch {
    return { ok: false, error: "invalidUrl" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "invalidProtocol" };
  if (url.hostname.toLowerCase() !== "github.com" && url.hostname.toLowerCase() !== "www.github.com") {
    return { ok: false, error: "notGitHub" };
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return { ok: false, error: "missingRepository" };
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    return { ok: false, error: "invalidRepository" };
  }
  if (repo === "." || repo === "..") return { ok: false, error: "invalidRepository" };

  return { ok: true, ref: { owner, repo }, url: `https://github.com/${owner}/${repo}` };
}

function errorMessageForStatus(status: number, body: string): string {
  if (status === 404) return "Repository not found. Check the URL, or the repository may be private.";
  if (status === 403 || status === 429) {
    return "GitHub API rate limit reached. Wait a few minutes and try again, or pick a local folder instead.";
  }
  if (status === 451) return "GitHub refused access to this repository.";
  const snippet = body.replace(/\s+/g, " ").slice(0, 160);
  return `GitHub request failed (HTTP ${status})${snippet ? `: ${snippet}` : ""}`;
}

async function githubFetch(
  state: GitHubRequestState,
  url: string,
  accept: string
): Promise<Response> {
  if (state.requests >= MAX_REQUESTS) {
    throw new IntelligenceError(
      "requestBudgetExceeded",
      "This repository needs more GitHub requests than Myra allows in one import. Try a local clone instead.",
      429
    );
  }
  state.requests += 1;

  let response: Response;
  try {
    response = await state.fetchImpl(url, {
      headers: {
        Accept: accept,
        "User-Agent": "MyraAI-Project-Intelligence",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw new IntelligenceError(
      timedOut ? "githubTimeout" : "githubUnreachable",
      timedOut
        ? "GitHub took too long to respond. Check your connection and try again."
        : "Could not reach GitHub. Check your network connection.",
      timedOut ? 504 : 502
    );
  }

  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining !== null && Number(remaining) === 0) {
    const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const minutes = reset > Date.now() ? Math.ceil((reset - Date.now()) / 60000) : 0;
    state.warnings.push(
      minutes > 0
        ? `GitHub API rate limit will reset in about ${minutes} minute(s).`
        : "GitHub API rate limit reached."
    );
  }

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    const code =
      response.status === 404
        ? "repositoryNotFound"
        : response.status === 403 || response.status === 429
          ? "rateLimited"
          : "githubError";
    throw new IntelligenceError(code, errorMessageForStatus(response.status, body), response.status);
  }

  return response;
}

function projectIdFor(owner: string, repo: string): string {
  return "proj_" + Buffer.from(`${owner}/${repo}`.toLowerCase()).toString("hex").slice(0, 16);
}

function decodeText(buf: Uint8Array): string | null {
  if (isBinaryBuffer(buf)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null; // GitHub source is UTF-8; anything else is not useful context.
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export async function fetchGitHubProject(
  rawUrl: string,
  options: GitHubImportOptions = {}
): Promise<ImportedProject> {
  const parsed = parseGitHubUrl(rawUrl);
  if ("error" in parsed) {
    throw new IntelligenceError("invalidGitHubUrl", `Not a usable public GitHub repository URL (${parsed.error}).`, 400);
  }
  const { owner, repo } = parsed.ref;
  const limits: ScanLimits = { ...DEFAULT_SCAN_LIMITS, ...(options.limits ?? {}) };
  const state: GitHubRequestState = {
    fetchImpl: options.fetchImpl ?? fetch,
    apiBase: options.apiBase ?? API_BASE,
    requests: 0,
    warnings: [],
  };

  const metaResponse = await githubFetch(
    state,
    `${state.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    "application/vnd.github+json"
  );
  let meta: any;
  try {
    meta = await metaResponse.json();
  } catch {
    throw new IntelligenceError("githubError", "GitHub returned an unreadable repository response.", 502);
  }
  if (meta?.private === true) {
    throw new IntelligenceError(
      "privateUnsupported",
      "Private repositories are not supported yet. Use the local folder import for a private project.",
      400
    );
  }

  const branch = typeof meta?.default_branch === "string" && meta.default_branch ? meta.default_branch : "main";

  const treeResponse = await githubFetch(
    state,
    `${state.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    "application/vnd.github+json"
  );
  let treePayload: any;
  try {
    treePayload = await treeResponse.json();
  } catch {
    throw new IntelligenceError("githubError", "GitHub returned an unreadable file tree.", 502);
  }

  const entries: any[] = Array.isArray(treePayload?.tree) ? treePayload.tree : [];
  if (entries.length === 0) {
    throw new IntelligenceError("emptyRepository", "This repository has no files to analyse.", 422);
  }
  if (treePayload?.truncated === true || entries.length > MAX_TREE_ENTRIES) {
    state.warnings.push("The repository tree was truncated by GitHub; only a subset of files was considered.");
  }

  const candidates: { rel: string; size: number; score: number }[] = [];
  const tree: ProjectNode[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const entry of entries.slice(0, MAX_TREE_ENTRIES)) {
    if (typeof entry?.path !== "string") continue;
    const rel = entry.path;
    if (rel.split("/").some((part: string) => part === ".." || part === "")) continue;

    if (entry.type === "tree") {
      if (tree.length < MAX_TREE_NODES) tree.push({ path: rel + "/", type: "dir" });
      continue;
    }
    if (entry.type !== "blob") continue;

    const size = typeof entry.size === "number" ? entry.size : 0;
    const classification = classifyFile(rel, size, limits);
    if (!classification.include) {
      skipped.push({ path: rel, reason: classification.reason ?? "excluded" });
      continue;
    }
    candidates.push({ rel, size, score: scoreFile(rel) });
    if (tree.length < MAX_TREE_NODES) tree.push({ path: rel, type: "file", size });
  }

  candidates.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));

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

    const encodedPath = candidate.rel.split("/").map(encodeURIComponent).join("/");
    let response: Response;
    try {
      response = await githubFetch(
        state,
        `${options.rawBase ?? RAW_BASE}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${encodedPath}`,
        "text/plain"
      );
    } catch (err) {
      // One unreadable file must not fail the whole import.
      if (err instanceof IntelligenceError && (err.code === "rateLimited" || err.code === "requestBudgetExceeded")) {
        state.warnings.push("File fetching stopped early because of GitHub limits.");
        break;
      }
      skipped.push({ path: candidate.rel, reason: "fetchFailed" });
      continue;
    }

    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > limits.maxFileBytes) {
      skipped.push({ path: candidate.rel, reason: "tooLarge" });
      continue;
    }

    let buffer: Uint8Array;
    try {
      buffer = new Uint8Array(await response.arrayBuffer());
    } catch {
      skipped.push({ path: candidate.rel, reason: "fetchFailed" });
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
    const redacted = redactSecrets(truncated ? decoded.slice(0, remaining) : decoded);
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
      "No readable source files were found in that repository after filtering.",
      422
    );
  }

  const repoUrl = `https://github.com/${owner}/${repo}`;
  // Guard: the importer never exposes absolute local paths, but this keeps the
  // intent explicit for the shared ProjectSource type.
  const source = {
    kind: "github" as const,
    repoUrl,
    owner,
    repo,
    branch,
    treeSha: typeof treePayload?.sha === "string" ? treePayload.sha : undefined,
  };

  if (typeof meta?.description === "string" && meta.description.trim()) {
    state.warnings.push(`GitHub description: ${meta.description.trim().slice(0, 200)}`);
  }

  return {
    projectId: projectIdFor(owner, repo),
    name: repo,
    source,
    files,
    tree,
    warnings: state.warnings,
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

// Re-exported for callers that only need the defensive helper in tests.
export { isInsideRoot };
