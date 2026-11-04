/**
 * Myra AI — T5.0/T5R IPC payload validation + canonical serialization (main process).
 *
 * Every IPC payload arriving from the renderer is treated as attacker-
 * controlled. Purely structural + typed validation happens here before the
 * Handoff Authority ever looks at a payload.
 *
 * T5R Phase B additions:
 *   - strictCanonicalJson: VALIDATING canonicalizer. Unsupported values
 *     (non-finite numbers, class instances, functions, symbols, bigints,
 *     undefined, excessive depth/size) are REJECTED (returns null) rather
 *     than mapped to string sentinels — sentinels were collision-prone.
 *     Both endpoints are Node/V8, so JSON.parse -> strictCanonicalJson is
 *     byte-identical on both sides of the trust boundary.
 *   - Domain-separated HMAC helpers (no ambiguous string concatenation).
 *
 * No secrets, no executors, no side effects live in this module.
 */

const crypto = require("crypto");

// Domain-separated HMAC prefixes. MIRRORED in src/server/handoff.ts — keep in sync.
const TICKET_DOMAIN = "myra-t5r-ticket-v1\u0000";
const COMPLETION_DOMAIN = "myra-t5r-completion-v1\u0000";

// Structural caps for canonical serialization.
const MAX_DEPTH = 10;
const MAX_KEYS = 128;
const MAX_ARRAY = 1024;

/**
 * Deterministic canonical JSON for JSON-round-trip-stable values only.
 * Returns the canonical string, or null when the value contains anything
 * that would not survive JSON.parse identically (the "reject, don't map"
 * policy from the approved Rev 3 design).
 */
function strictCanonicalJson(value, depth = 0) {
  if (depth > MAX_DEPTH) return null;
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) return null;
    const parts = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const s = strictCanonicalJson(value[i], depth + 1);
      if (s === null) return null;
      parts[i] = s;
    }
    return "[" + parts.join(",") + "]";
  }
  if (t === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null; // class instances rejected
    const keys = Object.keys(value);
    if (keys.length > MAX_KEYS) return null;
    keys.sort();
    const parts = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = value[k];
      const tv = typeof v;
      if (v === undefined || tv === "function" || tv === "symbol" || tv === "bigint") return null;
      const s = strictCanonicalJson(v, depth + 1);
      if (s === null) return null;
      parts[i] = JSON.stringify(k) + ":" + s;
    }
    return "{" + parts.join(",") + "}";
  }
  return null; // undefined, function, symbol, bigint — unsupported
}

/** Canonicalize + size-cap in one step. Returns string or null. */
function canonicalJsonOrNull(value, maxBytes = 16 * 1024) {
  try {
    const text = strictCanonicalJson(value);
    if (text === null || text.length === 0 || text.length > maxBytes) return null;
    return text;
  } catch (err) {
    return null;
  }
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Domain-separated HMAC: sig = HMAC(key, domain || canonicalPayload). */
function hmacHex(keyBuffer, domain, canonicalPayload) {
  return crypto.createHmac("sha256", keyBuffer).update(domain + canonicalPayload).digest("hex");
}

/** Constant-time comparison for equal-purpose ASCII strings. */
function timingSafeEqStrings(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || b.length === 0) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isSafeId(value, maxLen = 64) {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLen && /^[A-Za-z0-9_:.:-]+$/.test(value);
}

/** sha256 hex digest (lowercase, 64 chars). */
function isHex64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Session identifier issued by the server: 8..64 chars of [A-Za-z0-9_-]. */
function isSessionId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

module.exports = {
  strictCanonicalJson,
  canonicalJsonOrNull,
  sha256Hex,
  hmacHex,
  timingSafeEqStrings,
  isPlainObject,
  isSafeId,
  isHex64,
  isSessionId,
  TICKET_DOMAIN,
  COMPLETION_DOMAIN,
  MAX_DEPTH,
  MAX_KEYS,
  MAX_ARRAY,
};
