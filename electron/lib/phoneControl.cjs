"use strict";

/**
 * Myra AI — Microsoft Phone Link bridge (Electron MAIN process).
 *
 * HONEST SCOPE. There is no public Phone Link / Link to Windows API:
 * Microsoft's own answers state that Phone Link is a system app whose "API and
 * deep functions are usually not open to the public". Verified on this machine:
 *  - no `ms-phone:` shell\open command (Store-app activation only),
 *  - `tel:` and `callto:` are owned by ANOTHER app (Office `lync.exe`), so a
 *    `tel:` deep link cannot reach Phone Link at all,
 *  - no documented registry key exposing phone connection state.
 *
 * Therefore Myra does NOT claim to place calls. This module only:
 *  - reports whether Phone Link is installed/running and why dialling is not
 *    supported, so the model tells the user the truth, and
 *  - asks Windows to bring Phone Link to the front (a request, not a call), so
 *    the user can tap the contact themselves.
 *
 * No credentials, no phone databases, no keystroke injection, no process kills.
 */

const { execFile } = require("child_process");

const PHONE_LINK_PROCESS = "PhoneExperienceHost.exe";
const PHONE_LINK_AUMID = "Microsoft.YourPhone_8wekyb3d8bbwe!App";

const CALLS_UNSUPPORTED_REASON = "phoneLinkHasNoPublicApi";

function execFileSafe(file, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve({ ok: !err, out: String(stdout || "") });
      });
    } catch {
      resolve({ ok: false, out: "" });
    }
  });
}

function createPhoneBridge({ audit, log, openExternal } = {}) {
  const record = typeof audit === "function" ? audit : () => {};
  const emit = typeof log === "function" ? log : () => {};

  /** Is the Phone Link host process running right now? Fixed, read-only tasklist query. */
  async function isPhoneLinkRunning() {
    if (process.platform !== "win32") return false;
    const res = await execFileSafe("tasklist", ["/FI", `IMAGENAME eq ${PHONE_LINK_PROCESS}`, "/NH"]);
    return res.out.toLowerCase().includes(PHONE_LINK_PROCESS.toLowerCase());
  }

  async function status() {
    const running = await isPhoneLinkRunning();
    return {
      ok: true,
      phoneLinkAvailable: running,
      phoneLinkRunning: running,
      callsSupported: false,
      reason: CALLS_UNSUPPORTED_REASON,
      // Spoken honestly by Myra; no invented capability.
      detail:
        "Phone Link has no public API on Windows and the tel: link on this PC belongs to another app, " +
        "so I cannot place the call myself. I can open Phone Link for you and you can tap the contact to call.",
    };
  }

  /** Bring Phone Link to the front. Reported as a REQUEST, never as a completed call. */
  async function open() {
    try {
      const running = await isPhoneLinkRunning();
      const opener = typeof openExternal === "function" ? openExternal : null;
      if (!opener) return { ok: false, error: "openExternalUnavailable" };

      // Store-app activation is the only supported way to bring Phone Link up.
      await opener(`shell:AppsFolder\\${PHONE_LINK_AUMID}`);

      record("PHONE_LINK_OPEN_REQUESTED", { tool: "phoneControl" });
      return {
        ok: true,
        opened: true,
        wasRunning: running,
        callsSupported: false,
        reason: CALLS_UNSUPPORTED_REASON,
        detail: "Phone Link ko saamne le aayi hoon. Call aap contact par tap karke kar sakte hain.",
      };
    } catch (err) {
      record("PHONE_LINK_OPEN_FAILED", { tool: "phoneControl" });
      emit("Phone Link open failed:", err && err.message);
      return { ok: false, error: "phoneLinkOpenFailed", callsSupported: false };
    }
  }

  return { status, open };
}

module.exports = {
  createPhoneBridge,
  CALLS_UNSUPPORTED_REASON,
  PHONE_LINK_PROCESS,
  PHONE_LINK_AUMID,
};
