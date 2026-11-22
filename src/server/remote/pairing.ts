/**
 * Myra AI — Phase 1 remote pairing.
 *
 * Security model:
 *  - A short-lived 6-digit code is shown ONLY in the authenticated desktop UI.
 *  - Exchanging a valid code returns a 256-bit phone session token.
 *  - Only the SHA-256 hash of the token is stored in memory.
 *  - Exactly one phone session is active at a time; pairing a new phone
 *    revokes the previous token.
 *  - Pairing attempts are rate limited per client key.
 *  - Nothing here is persisted: a server restart invalidates every pairing.
 *
 * This module never logs codes or tokens.
 */

import crypto from "crypto";

export const PAIRING_CODE_LENGTH = 6;
export const DEFAULT_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_ATTEMPT_WINDOW_MS = 60 * 1000; // 1 minute

export interface PairingSession {
  id: string;
  deviceName: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

export interface PairingInfo {
  code: string;
  expiresAt: number;
  pairedDevice: string | null;
  pairedAt: number | null;
}

export type PairResult =
  | {
      ok: true;
      token: string;
      sessionId: string;
      deviceName: string;
      expiresAt: number;
    }
  | {
      ok: false;
      reason: "invalidCode" | "expiredCode" | "rateLimited";
      retryAfterMs?: number;
    };

export interface PairingManagerOptions {
  codeTtlMs?: number;
  sessionTtlMs?: number;
  maxAttempts?: number;
  attemptWindowMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function timingSafeEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sanitizeDeviceName(raw: unknown): string {
  const text = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 64);
  return text || "Phone";
}

function generateCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(PAIRING_CODE_LENGTH, "0");
}

export class PairingManager {
  readonly codeTtlMs: number;
  readonly sessionTtlMs: number;

  private readonly maxAttempts: number;
  private readonly attemptWindowMs: number;
  private readonly now: () => number;

  private code: string | null = null;
  private codeExpiresAt = 0;
  private codeConsumed = false;

  private session: PairingSession | null = null;

  private readonly attempts = new Map<string, { count: number; windowStart: number }>();
  private readonly listeners = new Set<() => void>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: PairingManagerOptions = {}) {
    this.codeTtlMs = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.attemptWindowMs = options.attemptWindowMs ?? DEFAULT_ATTEMPT_WINDOW_MS;
    this.now = options.now ?? Date.now;

    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
    // Never keep the Node process alive just for pairing cleanup.
    if (typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  /** Subscribe to session changes (pair, unpair, expiry). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Current pairing code + active device metadata. Rotates expired/consumed codes. */
  getInfo(): PairingInfo {
    this.ensureCode();
    return {
      code: this.code as string,
      expiresAt: this.codeExpiresAt,
      pairedDevice: this.session ? this.session.deviceName : null,
      pairedAt: this.session ? this.session.createdAt : null,
    };
  }

  /** Force a new code (desktop "New code" button). */
  rotateCode(): PairingInfo {
    this.code = generateCode();
    this.codeExpiresAt = this.now() + this.codeTtlMs;
    this.codeConsumed = false;
    return this.getInfo();
  }

  pair(input: { code: string; deviceName?: string; clientKey?: string }): PairResult {
    const now = this.now();
    const clientKey = String(input.clientKey ?? "unknown");

    const rate = this.attempts.get(clientKey);
    if (rate && now - rate.windowStart < this.attemptWindowMs) {
      if (rate.count >= this.maxAttempts) {
        return {
          ok: false,
          reason: "rateLimited",
          retryAfterMs: Math.max(0, this.attemptWindowMs - (now - rate.windowStart)),
        };
      }
    } else if (rate) {
      this.attempts.delete(clientKey);
    }

    // Detect an expired-but-unconsumed code BEFORE ensureCode() rotates it.
    if (this.code && !this.codeConsumed && now > this.codeExpiresAt) {
      this.recordFailure(clientKey, now);
      this.code = null;
      this.codeConsumed = false;
      this.ensureCode();
      return { ok: false, reason: "expiredCode" };
    }

    this.ensureCode();

    const supplied = String(input.code ?? "").trim();
    if (
      this.codeConsumed ||
      !this.code ||
      supplied.length !== this.code.length ||
      !timingSafeEq(supplied, this.code)
    ) {
      this.recordFailure(clientKey, now);
      return { ok: false, reason: "invalidCode" };
    }

    // Success: consume the one-time code and reset the rate limiter.
    this.codeConsumed = true;
    this.attempts.delete(clientKey);

    const token = crypto.randomBytes(32).toString("base64url");
    const session: PairingSession = {
      id: crypto.randomBytes(8).toString("hex"),
      deviceName: sanitizeDeviceName(input.deviceName),
      tokenHash: sha256Hex(token),
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
      lastSeenAt: now,
    };

    // Exactly one phone session. Pairing a new phone revokes the old token.
    this.session = session;
    this.notify();

    return {
      ok: true,
      token,
      sessionId: session.id,
      deviceName: session.deviceName,
      expiresAt: session.expiresAt,
    };
  }

  /** Validate a token and refresh its last-seen timestamp. */
  verify(token: string | null | undefined): PairingSession | null {
    if (!token || !this.session) return null;
    const now = this.now();
    if (now > this.session.expiresAt) {
      this.session = null;
      this.notify();
      return null;
    }
    if (!timingSafeEq(sha256Hex(token), this.session.tokenHash)) return null;
    this.session.lastSeenAt = now;
    return this.session;
  }

  /** Revoke the session that owns this token. */
  unpair(token: string | null | undefined): boolean {
    if (!token || !this.session) return false;
    if (!timingSafeEq(sha256Hex(token), this.session.tokenHash)) return false;
    this.session = null;
    this.notify();
    return true;
  }

  /** True while the given session id is still the active pairing. */
  isSessionActive(sessionId: string): boolean {
    if (!this.session) return false;
    if (this.session.id !== sessionId) return false;
    if (this.now() > this.session.expiresAt) {
      this.session = null;
      this.notify();
      return false;
    }
    return true;
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.listeners.clear();
    this.session = null;
    this.attempts.clear();
  }

  private ensureCode(): void {
    if (!this.code || this.codeConsumed || this.now() > this.codeExpiresAt) {
      this.code = generateCode();
      this.codeExpiresAt = this.now() + this.codeTtlMs;
      this.codeConsumed = false;
    }
  }

  private recordFailure(clientKey: string, now: number): void {
    const existing = this.attempts.get(clientKey);
    if (!existing || now - existing.windowStart >= this.attemptWindowMs) {
      this.attempts.set(clientKey, { count: 1, windowStart: now });
      return;
    }
    existing.count += 1;
  }

  private cleanup(): void {
    const now = this.now();
    if (this.session && now > this.session.expiresAt) {
      this.session = null;
      this.notify();
    }
    if (this.code && now > this.codeExpiresAt) {
      this.code = null;
      this.codeConsumed = false;
    }
    for (const [key, entry] of this.attempts) {
      if (now - entry.windowStart >= this.attemptWindowMs) this.attempts.delete(key);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* listener failures must never break pairing */
      }
    }
  }
}
