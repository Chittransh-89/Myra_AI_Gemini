/**
 * Myra AI — project file selection policy.
 *
 * Shared by the local scanner and the GitHub importer so both sources obey the
 * same exclusions, size limits and secret-file rules.
 *
 * Nothing here touches the filesystem or the network.
 */

import path from "path";

/** Directories that are never worth analysing (and often enormous). */
export const EXCLUDED_DIRS = new Set<string>([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "output",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  "vendor",
  "cache",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".yarn",
  ".pnp",
  "tmp",
  "temp",
  "logs",
  "log",
  "release",
  "releases",
  ".venv",
  "venv",
  "env",
  "virtualenv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".idea",
  ".vscode",
  ".gradle",
  ".dart_tool",
  "target",
  "obj",
  "Pods",
  ".terraform",
  ".serverless",
  ".freebuff",
  "bower_components",
  "jspm_packages",
  ".angular",
  ".expo",
  ".vercel",
  ".netlify",
  "site-packages",
]);

/** Extensions that carry no useful source context. */
export const EXCLUDED_EXTENSIONS = new Set<string>([
  // media / images
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".icns", ".svgz",
  ".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".mp4", ".mov", ".avi",
  ".mkv", ".webm", ".wmv", ".flv",
  // archives / binaries / fonts
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".7z", ".rar", ".exe", ".dll", ".so",
  ".dylib", ".bin", ".dat", ".iso", ".msi", ".dmg", ".class", ".jar", ".war",
  ".pyc", ".pyo", ".wasm", ".node", ".o", ".obj", ".a", ".lib", ".pdb",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  // generated / build metadata
  ".map", ".min.js", ".min.css", ".lockb", ".sqlite", ".sqlite3", ".db",
  ".parquet", ".snap", ".pid",
  // office documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
]);

const SOURCE_EXTENSIONS = new Set<string>([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".pyw", ".rb", ".php", ".java", ".kt", ".kts", ".scala", ".clj",
  ".go", ".rs", ".cs", ".fs", ".vb", ".swift", ".m", ".mm", ".dart", ".lua",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx",
  ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
  ".html", ".htm", ".xhtml", ".css", ".scss", ".sass", ".less", ".vue",
  ".svelte", ".astro", ".ejs", ".hbs", ".pug", ".jinja", ".j2",
  ".sql", ".graphql", ".gql", ".proto", ".tf", ".tfvars", ".sol", ".ex", ".exs",
  ".erl", ".hrl", ".r", ".jl", ".pl", ".pm", ".elm", ".zig", ".nim",
]);

const CONFIG_EXTENSIONS = new Set<string>([
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".conf", ".properties", ".env.example", ".md", ".markdown", ".mdx", ".txt",
  ".rst", ".adoc", ".tex", ".csv", ".tsv", ".xml", ".plist", ".gradle",
]);

const CONFIG_FILENAMES = new Set<string>([
  "dockerfile", "makefile", "procfile", "gemfile", "rakefile", "podfile",
  "jenkinsfile", "vagrantfile", "cmakelists.txt", "requirements.txt",
  "constraints.txt", "pipfile", ".gitignore", ".dockerignore", ".editorconfig",
  ".nvmrc", ".node-version", ".python-version", ".tool-versions",
]);

const LOCKFILENAMES = new Set<string>([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "bun.lockb", "composer.lock", "poetry.lock", "pipfile.lock", "gemfile.lock",
  "cargo.lock", "go.sum", "gradle.lockfile", "packages.lock.json",
  "mix.lock", "podfile.lock",
]);

/** Files whose contents must never be sent anywhere. */
const SENSITIVE_NAME_RX: RegExp[] = [
  /^\.env(\..*)?$/i, // .env, .env.local, .env.production …
  /\.(pem|key|pfx|p12|keystore|jks|asc|gpg|pgp)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.git-credentials$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^(credentials|credential|secrets?|passwords?|tokens?)(\.(json|ya?ml|txt|ini|env|xml))?$/i,
  /\.(kdbx|ovpn)$/i,
];

const SENSITIVE_DIR_RX: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.azure(\/|$)/i,
  /(^|\/)\.kube(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
];

export interface ScanLimits {
  /** Maximum bytes read from any single file. */
  maxFileBytes: number;
  /** Maximum characters of source context in total. */
  maxTotalChars: number;
  /** Maximum number of files included. */
  maxFiles: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxFileBytes: 200 * 1024,
  maxTotalChars: 700_000,
  maxFiles: 160,
};

export function toPosix(p: string): string {
  return String(p).replace(/\\/g, "/");
}

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME_RX.some((rx) => rx.test(name));
}

export function isSensitivePath(relPath: string): boolean {
  const normalized = toPosix(relPath);
  if (SENSITIVE_DIR_RX.some((rx) => rx.test("/" + normalized))) return true;
  return normalized.split("/").some((part) => isSensitiveName(part));
}

export function isLockfile(name: string): boolean {
  return LOCKFILENAMES.has(name.toLowerCase());
}

export function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIRS.has(name.toLowerCase()) || name.startsWith(".");
}

export function isBinaryBuffer(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return false;
  let nul = 0;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) nul++;
    else if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return nul > 0 || control / n > 0.02;
}

/** Decide whether a file can be read for analysis. */
export function classifyFile(
  relPath: string,
  sizeBytes: number,
  limits: ScanLimits = DEFAULT_SCAN_LIMITS
): { include: boolean; reason?: string } {
  const posix = toPosix(relPath);
  const name = posix.split("/").pop() ?? posix;
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";

  if (!posix || posix.includes("\u0000")) return { include: false, reason: "badPath" };
  if (posix.split("/").some((part) => part === "..")) return { include: false, reason: "pathTraversal" };
  if (isSensitivePath(posix)) return { include: false, reason: "sensitive" };
  if (isLockfile(name)) return { include: false, reason: "lockfile" };
  if (lower.endsWith(".min.js") || lower.endsWith(".min.css")) {
    return { include: false, reason: "minified" };
  }
  if (EXCLUDED_EXTENSIONS.has(ext)) return { include: false, reason: "binaryOrMedia" };
  if (sizeBytes > limits.maxFileBytes) return { include: false, reason: "tooLarge" };

  const isKnownConfig = CONFIG_FILENAMES.has(lower);
  const isReadableExt =
    SOURCE_EXTENSIONS.has(ext) || CONFIG_EXTENSIONS.has(ext) || ext === "";
  if (!isKnownConfig && !isReadableExt) return { include: false, reason: "unsupportedType" };

  return { include: true };
}

/**
 * Priority score: higher is more useful for understanding a project.
 * Used to decide which files fit inside the context budget.
 */
export function scoreFile(relPath: string): number {
  const posix = toPosix(relPath).toLowerCase();
  const name = posix.split("/").pop() ?? posix;
  const depth = posix.split("/").length;
  let score = 50 - Math.min(depth, 12) * 2;

  if (/^readme(\.|$)/.test(name)) score += 120;
  if (name === "package.json") score += 110;
  if (name === "pyproject.toml" || name === "requirements.txt") score += 95;
  if (name === "go.mod" || name === "cargo.toml" || name === "pom.xml") score += 95;
  if (/^(vite|next|webpack|rollup|tsup|esbuild)\.config\./.test(name)) score += 80;
  if (/^(tsconfig|jsconfig)(\..*)?\.json$/.test(name)) score += 60;
  if (name === "dockerfile" || name === "docker-compose.yml" || name === "compose.yml") score += 55;

  // Entry points and core server/frontend code.
  if (/^(src|app|server|api|lib|core)\//.test(posix)) score += 30;
  if (/^(index|main|server|app|router|routes|api|handler)\.(t|j)sx?$/.test(name)) score += 45;
  if (/^(app|main|server)\.py$/.test(name)) score += 45;
  if (/^(main|lib)\.(go|rs)$/.test(name)) score += 45;

  if (posix.includes("/components/")) score += 12;
  if (posix.includes("/routes/") || posix.includes("/api/")) score += 12;
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(posix)) score -= 40;
  if (/\.(test|spec)\./.test(name)) score -= 40;
  if (/\.(md|mdx|rst|txt)$/.test(name)) score -= 10;
  if (/\.(json|ya?ml|toml|ini)$/.test(name)) score -= 5;
  if (/generated|vendored|\.bundle\.|\.chunk\./.test(name)) score -= 50;

  return score;
}

/** True when `candidate` is `root` itself or a descendant of it. */
export function isInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === "") return true;
  if (relative === ".." || relative.startsWith(".." + path.sep)) return false;
  if (path.isAbsolute(relative)) return false;
  return true;
}

/** Reject roots that would scan the whole machine or the user's home folder. */
export function isTooBroadRoot(root: string, homeDir?: string): boolean {
  const resolved = path.resolve(root);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) return true;
  if (homeDir && path.resolve(homeDir) === resolved) return true;
  // Windows drive roots look like "C:\" (parsed.root === "C:\").
  return false;
}
