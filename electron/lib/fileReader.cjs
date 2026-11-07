"use strict";

/**
 * Myra AI — file reading engine (ELECTRON MAIN PROCESS ONLY).
 *
 * Pure-ish, Electron-free helpers used by fileControl.cjs:
 *   - absolute-path validation (no traversal, UNC, device names, ADS)
 *   - encoding detection/decoding with an explicit fallback warning
 *   - binary sniffing so garbage is never presented as "text"
 *   - real PDF text extraction (pdf-parse) and DOCX text extraction
 *     (minimal ZIP reader + WordprocessingML -> text, no new dependency)
 *   - bounded, chunked text slicing that fits the signed-completion budget
 *   - literal search with line/column numbers
 *
 * NOTHING here executes file contents, spawns processes or touches the network.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const MAX_FILE_BYTES = 64 * 1024 * 1024; // refuse larger files with a clear error
const MAX_TEXT_CHARS = 4 * 1024 * 1024; // extracted-text cap (memory guard)
const MAX_DOCX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4096;

const DEFAULT_CHUNK_CHARS = 4000;
const MAX_CHUNK_CHARS = 12000;
const MIN_CHUNK_CHARS = 200;
// The Handoff Authority caps a completion result at 8192 canonical chars
// (MAX_RESULT_BYTES in handoffAuthority.cjs). Leave headroom for the receipt.
const RESULT_JSON_BUDGET = 7400;

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonc", ".json5",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".pyw", ".pyi",
  ".html", ".htm", ".xhtml", ".css", ".scss", ".sass", ".less", ".xml", ".svg",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".properties", ".env",
  ".log", ".text", ".rst", ".adoc", ".tex", ".srt", ".vtt", ".diff", ".patch",
  ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd", ".java", ".kt", ".kts",
  ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".cs", ".go", ".rs", ".rb",
  ".php", ".sql", ".vue", ".svelte", ".astro", ".lua", ".r", ".dart", ".swift",
  ".m", ".mm", ".scala", ".clj", ".cljs", ".ex", ".exs", ".erl", ".hrl",
  ".graphql", ".gql", ".proto", ".tf", ".tfvars", ".gradle", ".dockerignore",
  ".gitignore", ".gitattributes", ".editorconfig", ".lock", ".ipynb",
]);

const SENSITIVE_RX = [
  /\.env(\.[^\\/]+)?$/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.pypirc$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
  /(^|[\\/])(credentials|credential|secrets?|passwords?|tokens?)(\.(json|ya?ml|txt|ini|env))?$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.azure([\\/]|$)/i,
  /(^|[\\/])\.kube([\\/]|$)/i,
];

const RESERVED_BASENAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Path policy
// ---------------------------------------------------------------------------

/**
 * Validate a model-supplied absolute file path structurally.
 * Rejects: relative paths, UNC/network paths, device namespaces, NTFS
 * alternate-data-stream colons, NUL bytes, reserved device basenames.
 */
function validateFilePath(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return { ok: false, error: "emptyPath" };
  if (text.length > 1000) return { ok: false, error: "pathTooLong" };
  if (text.indexOf("\u0000") >= 0) return { ok: false, error: "badPath" };

  // \\.\  \\?\  and plain UNC \\server\share are all refused.
  if (/^\\\\[.?]\\/.test(text) || /^\\\\[^\\]/.test(text) || /^\/\//.test(text)) {
    return { ok: false, error: "unsupportedPath" };
  }
  if (!path.isAbsolute(text)) return { ok: false, error: "pathNotAbsolute" };

  if (process.platform === "win32") {
    if (!/^[A-Za-z]:[\\/]/.test(text)) return { ok: false, error: "pathNotAbsolute" };
    // Anything after the drive colon that still contains a colon is an ADS
    // (or malformed) path.
    if (text.slice(2).indexOf(":") >= 0) return { ok: false, error: "badPath" };
  }
  const base = path.basename(text);
  if (RESERVED_BASENAMES.test(base)) return { ok: false, error: "badPath" };

  return { ok: true, path: path.resolve(text) };
}

function extensionOf(filePath) {
  const name = path.basename(String(filePath || ""));
  const ext = path.extname(name).toLowerCase();
  if (!ext && name.startsWith(".")) return name.toLowerCase(); // ".env", ".gitignore"
  return ext;
}

function isSensitivePath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  return SENSITIVE_RX.some((rx) => rx.test(normalized));
}

function deriveId(realPath) {
  return "file_" + crypto.createHash("sha256").update(String(realPath)).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Encoding + binary detection
// ---------------------------------------------------------------------------

function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Decode a text buffer with an explicit, reported fallback — never silent. */
function decodeText(buf) {
  const warnings = [];
  let encoding = "utf-8";
  let body = buf;

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    body = buf.subarray(3);
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    encoding = "utf-16le";
    body = buf.subarray(2);
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    encoding = "utf-16be";
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    body = swapped;
    if (buf.length % 2 !== 0) warnings.push("oddByteLength");
  }

  let text;
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    text = new TextDecoder("utf-16le").decode(body);
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      text = body.toString("latin1");
      encoding = "latin1";
      warnings.push("nonUtf8DecodedAsLatin1");
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text: normalizeNewlines(text), encoding, warnings };
}

/** Cheap binary sniff on raw bytes (used only for non-PDF/DOCX files). */
function hasUtf16Bom(buf) {
  return buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 16384);
  if (n === 0) return false;
  let nul = 0;
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) nul++;
    else if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  return nul > 0 || ctrl / n > 0.02;
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (DOCX is a ZIP; no extra dependency)
// ---------------------------------------------------------------------------

function zipError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function findEndOfCentralDirectory(buf) {
  const start = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function listZipEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw zipError("badZip");
  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ZIP_ENTRIES) throw zipError("tooManyEntries");

  const entries = new Map();
  let off = centralOffset;
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    if (off + 46 + nameLen > buf.length) break;
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, uncompSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entry) {
  const off = entry.localOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) throw zipError("badZipEntry");
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const end = start + entry.compSize;
  if (end > buf.length || start > end) throw zipError("badZipEntry");
  if (entry.uncompSize > MAX_DOCX_ENTRY_BYTES) throw zipError("docxEntryTooLarge");

  const data = buf.subarray(start, end);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) {
    return zlib.inflateRawSync(data, { maxOutputLength: MAX_DOCX_ENTRY_BYTES });
  }
  throw zipError("unsupportedCompression");
}

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** WordprocessingML -> readable text, preserving paragraphs, tabs and rows. */
function docxXmlToText(xml) {
  let text = String(xml);
  text = text.replace(/<w:tab\b[^>]*\/>/g, "\t");
  text = text.replace(/<w:br\b[^>]*\/>/g, "\n");
  text = text.replace(/<w:cr\b[^>]*\/>/g, "\n");
  text = text.replace(/<\/w:tc>/g, "\t");
  text = text.replace(/<\/w:tr>/g, "\n");
  text = text.replace(/<\/w:p>/g, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeXmlEntities(text);
  text = normalizeNewlines(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

function extractDocxText(buf) {
  const entries = listZipEntries(buf);
  const main = entries.get("word/document.xml");
  if (!main) throw zipError("docxFormatUnsupported");
  const xml = readZipEntry(buf, main).toString("utf8");
  const text = docxXmlToText(xml);
  return { text, warnings: [] };
}

async function extractPdfText(buf) {
  let pdfParse;
  try {
    pdfParse = require("pdf-parse");
  } catch {
    throw zipError("pdfSupportUnavailable");
  }
  if (typeof pdfParse !== "function") throw zipError("pdfSupportUnavailable");
  // Hand pdf.js an exact-size, zero-offset view. `fs.readFile` can return a
  // slice of Node's shared buffer pool, and pdf.js 1.x can read pool bytes
  // instead of the view (surfacing as "bad XRef entry").
  const bytes = new Uint8Array(buf.length);
  bytes.set(buf);
  const data = await pdfParse(bytes, { max: 0 });
  const text = normalizeNewlines(String((data && data.text) || ""))
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return { text, pages: Number(data && data.numpages) || null, warnings: [] };
}

// ---------------------------------------------------------------------------
// Document extraction
// ---------------------------------------------------------------------------

/**
 * Read and extract one file. Always returns a structured result; an empty
 * extraction is an ERROR (noTextContent / noExtractableText), never a silent
 * empty success.
 */
async function extractDocument(filePath) {
  const validated = validateFilePath(filePath);
  if (!validated.ok) return { ok: false, error: validated.error };

  let stat;
  try {
    stat = await fsp.stat(validated.path);
  } catch {
    return { ok: false, error: "fileNotFound" };
  }
  if (!stat.isFile()) return { ok: false, error: "notAFile" };
  if (stat.size === 0) return { ok: false, error: "emptyFile", sizeBytes: 0 };
  if (stat.size > MAX_FILE_BYTES) {
    return { ok: false, error: "fileTooLarge", sizeBytes: stat.size, limitBytes: MAX_FILE_BYTES };
  }

  let realPath;
  try {
    realPath = await fsp.realpath(validated.path);
  } catch {
    return { ok: false, error: "fileNotFound" };
  }
  const realStat = await fsp.stat(realPath).catch(() => null);
  if (!realStat || !realStat.isFile()) return { ok: false, error: "notAFile" };

  const extension = extensionOf(validated.path);
  const name = path.basename(validated.path);
  let text = "";
  let encoding = null;
  let warnings = [];
  let kind = "text";
  let pages = null;

  try {
    if (extension === ".doc") {
      return {
        ok: false,
        error: "unsupportedFormat",
        format: ".doc",
        hint: "Legacy .doc is not supported. Save it as .docx or PDF and open it again.",
      };
    }

    if (extension === ".pdf") {
      kind = "pdf";
      const buf = await fsp.readFile(realPath);
      if (!looksLikePdf(buf)) return { ok: false, error: "pdfFormatUnsupported" };
      const parsed = await extractPdfText(buf);
      text = parsed.text;
      pages = parsed.pages;
      warnings = parsed.warnings;
      if (!text.trim()) {
        return {
          ok: false,
          error: "noExtractableText",
          kind,
          name,
          hint: "This PDF has no text layer (likely a scan). Myra will not invent its contents.",
        };
      }
    } else if (extension === ".docx") {
      kind = "docx";
      const buf = await fsp.readFile(realPath);
      const parsed = extractDocxText(buf);
      text = parsed.text;
      warnings = parsed.warnings;
      encoding = "utf-8";
      if (!text.trim()) {
        return { ok: false, error: "noExtractableText", kind, name };
      }
    } else {
      kind = "text";
      const buf = await fsp.readFile(realPath);
      // UTF-16 text is full of NUL bytes, so a BOM exempts it from the sniff.
      if (!hasUtf16Bom(buf) && looksBinary(buf)) {
        return { ok: false, error: "unsupportedBinary", extension: extension || null, name };
      }
      const decoded = decodeText(buf);
      text = decoded.text;
      encoding = decoded.encoding;
      warnings = decoded.warnings;
      if (!text.trim()) {
        return { ok: false, error: "noTextContent", name, encoding, sizeBytes: stat.size };
      }
    }
  } catch (err) {
    const code = String((err && err.code) || "readFailed");
    return {
      ok: false,
      error: code,
      name,
      detail: String((err && err.message) || "").slice(0, 160) || null,
    };
  }

  let truncated = false;
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    truncated = true;
    warnings = warnings.concat(["textTruncatedAtLimit"]);
  }

  return {
    ok: true,
    doc: {
      id: deriveId(realPath),
      path: realPath,
      name,
      extension: extension || null,
      kind,
      encoding: encoding || null,
      sizeBytes: stat.size,
      charCount: text.length,
      lineCount: text.length ? text.split("\n").length : 0,
      pages,
      text,
      truncated,
      warnings,
      sensitive: isSensitivePath(realPath),
    },
  };
}

function looksLikePdf(buf) {
  return buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-";
}

// ---------------------------------------------------------------------------
// Chunking + search
// ---------------------------------------------------------------------------

/** Document metadata safe to return on every call (never the whole text). */
function docBase(doc, action) {
  return {
    ok: true,
    action,
    id: doc.id,
    name: doc.name,
    path: doc.path,
    kind: doc.kind,
    encoding: doc.encoding,
    sizeBytes: doc.sizeBytes,
    charCount: doc.charCount,
    lineCount: doc.lineCount,
    pages: doc.pages == null ? null : doc.pages,
    truncated: doc.truncated === true,
    sensitive: doc.sensitive === true,
    warnings: Array.isArray(doc.warnings) ? doc.warnings : [],
  };
}

/**
 * Slice a chunk that is guaranteed to fit the signed-completion budget.
 * nextOffset always refers to the position AFTER the returned chunk, so a
 * follow-up read never skips or repeats text.
 */
function buildChunkResult(doc, action, offset, maxChars) {
  const total = doc.text.length;
  const start = Math.min(Math.max(0, Math.floor(Number(offset) || 0)), total);
  let size = Math.floor(Number(maxChars) || DEFAULT_CHUNK_CHARS);
  size = Math.min(Math.max(size, MIN_CHUNK_CHARS), MAX_CHUNK_CHARS);

  let chunk = doc.text.slice(start, start + size);
  const base = docBase(doc, action);
  const shape = () => ({
    ...base,
    offset: start,
    chunk,
    chunkChars: chunk.length,
    totalChars: total,
    nextOffset: start + chunk.length,
    hasMore: start + chunk.length < total,
  });

  let payload = shape();
  while (JSON.stringify(payload).length > RESULT_JSON_BUDGET && chunk.length > MIN_CHUNK_CHARS) {
    size = Math.max(MIN_CHUNK_CHARS, Math.floor(chunk.length * 0.7));
    chunk = doc.text.slice(start, start + size);
    payload = shape();
  }
  return payload;
}

/** Literal, case-insensitive search with 1-based line/column numbers. */
function searchText(text, query, maxMatches = 12) {
  const raw = String(query == null ? "" : query);
  if (raw.trim().length < 2) return { ok: false, error: "queryTooShort" };
  const needle = raw.toLowerCase();
  const lines = String(text).split("\n");
  const limit = Math.min(Math.max(Number(maxMatches) || 12, 1), 20);

  const matches = [];
  let totalMatches = 0;
  for (let i = 0; i < lines.length; i++) {
    if (totalMatches >= 500) break;
    const at = lines[i].toLowerCase().indexOf(needle);
    if (at === -1) continue;
    totalMatches++;
    if (matches.length < limit) {
      matches.push({
        line: i + 1,
        column: at + 1,
        text: lines[i].slice(0, 240),
      });
    }
  }
  return { ok: true, totalMatches, matches, truncatedCount: totalMatches >= 500 };
}

/** Line-aligned comparison summary (cheap, bounded). */
function compareTexts(a, b) {
  const aLines = String(a).split("\n");
  const bLines = String(b).split("\n");
  const shared = Math.min(aLines.length, bLines.length);
  const samples = [];
  let changed = 0;

  for (let i = 0; i < shared; i++) {
    if (aLines[i] === bLines[i]) continue;
    changed++;
    if (samples.length < 8) {
      samples.push({
        line: i + 1,
        a: aLines[i].slice(0, 160),
        b: bLines[i].slice(0, 160),
      });
    }
  }

  return {
    lineAligned: true,
    linesA: aLines.length,
    linesB: bLines.length,
    changedLines: changed,
    onlyInA: Math.max(0, aLines.length - bLines.length),
    onlyInB: Math.max(0, bLines.length - aLines.length),
    samples,
  };
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  DEFAULT_CHUNK_CHARS,
  MAX_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
  RESULT_JSON_BUDGET,
  TEXT_EXTENSIONS,
  validateFilePath,
  extensionOf,
  isSensitivePath,
  deriveId,
  decodeText,
  normalizeNewlines,
  looksBinary,
  hasUtf16Bom,
  listZipEntries,
  readZipEntry,
  docxXmlToText,
  extractDocxText,
  extractPdfText,
  extractDocument,
  docBase,
  buildChunkResult,
  searchText,
  compareTexts,
};
