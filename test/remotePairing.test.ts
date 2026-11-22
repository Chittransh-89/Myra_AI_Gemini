/**
 * Phase 1 targeted tests: pairing manager.
 *
 * Deterministic clock, no network. Run with:
 *   npx tsx test/remotePairing.test.ts
 */

import { PairingManager } from "../src/server/remote/pairing.js";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function failureReason(result: { ok: boolean; reason?: string }): string | null {
  return result.ok ? null : result.reason ?? null;
}

function run(): void {
  // --- Code shape + rotation ------------------------------------------------
  {
    let now = 1_000_000;
    const pairing = new PairingManager({ now: () => now });
    try {
      const first = pairing.getInfo();
      check(/^\d{6}$/.test(first.code), "pairing code must be 6 digits");
      check(first.expiresAt > now, "pairing code must have a future expiry");
      check(first.pairedDevice === null, "fresh manager must not be paired");

      const rotated = pairing.rotateCode();
      check(rotated.code !== first.code, "rotateCode must issue a different code");
    } finally {
      pairing.dispose();
    }
  }

  // --- Successful pairing, hashed storage, verify, unpair -------------------
  {
    const now = 2_000_000;
    const pairing = new PairingManager({ now: () => now });
    try {
      const code = pairing.getInfo().code;
      const result = pairing.pair({ code, deviceName: "Test Phone", clientKey: "test-1" });
      check(result.ok, "valid code must pair");
      if (!result.ok) return;

      check(result.token.length >= 40, "phone token must be high entropy");
      check(result.deviceName === "Test Phone", "device name must be echoed");
      check(pairing.getInfo().pairedDevice === "Test Phone", "paired device must be reported");

      const session = pairing.verify(result.token);
      check(session !== null, "issued token must verify");
      check(session?.deviceName === "Test Phone", "verified session keeps device name");
      check(pairing.verify("not-the-token") === null, "wrong token must be rejected");
      check(pairing.verify(null) === null, "missing token must be rejected");

      // Only a hash may be stored.
      const internal = pairing as unknown as {
        session: { tokenHash: string } | null;
      };
      check(
        typeof internal.session?.tokenHash === "string" &&
          /^[a-f0-9]{64}$/.test(internal.session.tokenHash),
        "pairing must store a SHA-256 token hash"
      );
      check(
        internal.session?.tokenHash !== result.token,
        "raw phone token must not be stored"
      );

      check(pairing.unpair(result.token), "unpair must succeed for the owning token");
      check(pairing.verify(result.token) === null, "unpaired token must stop verifying");
      check(pairing.getInfo().pairedDevice === null, "unpair must clear the paired device");
    } finally {
      pairing.dispose();
    }
  }

  // --- One-time use ---------------------------------------------------------
  {
    const now = 3_000_000;
    const pairing = new PairingManager({ now: () => now });
    try {
      const code = pairing.getInfo().code;
      check(pairing.pair({ code, clientKey: "test-2" }).ok, "first use must pair");

      const replay = pairing.pair({ code, clientKey: "test-2" });
      check(failureReason(replay) === "invalidCode", "code replay must be rejected");
    } finally {
      pairing.dispose();
    }
  }

  // --- Expired code ---------------------------------------------------------
  {
    let now = 4_000_000;
    const pairing = new PairingManager({ codeTtlMs: 1_000, now: () => now });
    try {
      const code = pairing.getInfo().code;
      now += 2_000;
      const result = pairing.pair({ code, clientKey: "test-3" });
      check(failureReason(result) === "expiredCode", "expired code must report expiredCode");
      check(/^\d{6}$/.test(pairing.getInfo().code), "a fresh code must be issued after expiry");
    } finally {
      pairing.dispose();
    }
  }

  // --- Rate limiting --------------------------------------------------------
  {
    const now = 5_000_000;
    const pairing = new PairingManager({
      maxAttempts: 2,
      attemptWindowMs: 60_000,
      now: () => now,
    });
    try {
      const code = pairing.getInfo().code;
      const wrong = code === "000000" ? "111111" : "000000";
      check(!pairing.pair({ code: wrong, clientKey: "test-4" }).ok, "wrong code must fail");
      check(!pairing.pair({ code: wrong, clientKey: "test-4" }).ok, "second wrong code must fail");

      const limited = pairing.pair({ code: wrong, clientKey: "test-4" });
      check(failureReason(limited) === "rateLimited", "third attempt must be rate limited");

      // A different client key is unaffected.
      check(
        pairing.pair({ code, clientKey: "other-client" }).ok,
        "rate limit must be per client key"
      );
    } finally {
      pairing.dispose();
    }
  }

  // --- Exactly one phone session -------------------------------------------
  {
    const now = 6_000_000;
    const pairing = new PairingManager({ now: () => now });
    try {
      const first = pairing.pair({ code: pairing.getInfo().code, deviceName: "Old Phone" });
      check(first.ok, "first phone must pair");
      if (!first.ok) return;

      const second = pairing.pair({
        code: pairing.rotateCode().code,
        deviceName: "New Phone",
      });
      check(second.ok, "second phone must pair");
      if (!second.ok) return;

      check(pairing.verify(first.token) === null, "pairing a new phone must revoke the old token");
      check(pairing.verify(second.token) !== null, "new phone token must verify");
      check(pairing.getInfo().pairedDevice === "New Phone", "newest device must be reported");
    } finally {
      pairing.dispose();
    }
  }

  console.log("remotePairing: all checks passed");
}

run();
