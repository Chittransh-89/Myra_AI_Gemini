/**
 * Myra AI — T5.0 Safe Audit Logger (main process).
 *
 * Append-only JSONL, one file per day, written to the app's userData/logs
 * directory. Contains ONLY security-relevant metadata:
 *   - event type, timestamps, tool NAME, callId, args DIGEST (sha256)
 *   - decision + rejection reasons
 * Never contains: arg values, file contents/paths, credentials, tokens,
 * the WS auth token, the HMAC key, or prompt content.
 *
 * Also exposes a small in-memory ring buffer used by the smoke harness to
 * verify that events actually happened (last N events).
 */

const path = require("path");
const fs = require("fs");

const REDACT_PATTERNS = [
  /([?&](?:key|api_key|apikey|api-key|access_token|token|password|secret)\s*=)[^&"',\s]+/gi, // credential-ish query params
  /(BEGIN [A-Z ]*PRIVATE KEY)/i,
];

const REDACTED = "[REDACTED]";
const MAX_FIELD_LENGTH = 120;

function sanitizeField(name, value) {
  // Only whitelisted field names may ever be written.
  const ALLOWED = new Set([
    "event", "ts", "runId", "callId", "tool", "argsDigest", "reason",
    "source", "transport", "pipeState", "ttlMs", "triggers", "medium",
  ]);
  if (!ALLOWED.has(name)) return { name: "__dropped_field__", value: REDACTED };
  let text;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") return { name, value };
  else if (value === null || value === undefined) return { name, value: null };
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = "[unserialisable]";
    }
  }
  for (const rx of REDACT_PATTERNS) text = text.replace(rx, "$1" + REDACTED);
  if (text.length > MAX_FIELD_LENGTH) text = text.slice(0, MAX_FIELD_LENGTH) + "...[truncated]";
  return { name, value: text };
}

function createAuditLogger(userDataDir, runId) {
  const dir = path.join(userDataDir, "logs");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    /* fall through; file writes also try-catch */
  }

  const ring = []; // smoke verification buffer
  let dayKey = "";
  let filePath = "";

  function currentFilePath() {
    const key = new Date().toISOString().slice(0, 10);
    if (key !== dayKey) {
      dayKey = key;
      filePath = path.join(dir, `audit-${key}.jsonl`);
    }
    return filePath;
  }

  function audit(event, fields = {}) {
    const entry = { event, ts: new Date().toISOString(), runId };
    for (const [k, v] of Object.entries(fields)) {
      const safe = sanitizeField(k, v);
      entry[safe.name === "__dropped_field__" ? k + "_dropped" : safe.name] = safe.value;
    }
    const line = JSON.stringify(entry);
    ring.push(line);
    if (ring.length > 200) ring.shift();
    try {
      fs.appendFile(currentFilePath(), line + "\n", () => {});
    } catch {
      /* never let audit failures crash the app */
    }
    return entry;
  }

  return {
    audit,
    recent: (n = 50) => ring.slice(-n),
    DIR: dir,
  };
}

module.exports = { createAuditLogger, sanitizeField };
