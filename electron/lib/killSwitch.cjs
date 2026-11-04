/**
 * Myra AI — T5.0 Kill Switch (main process owned).
 *
 * Engaging the kill switch:
 *   - aborts + clears ALL pending handoff tool registrations,
 *   - blocks new registrations,
 *   - blocks ticket consumption (executors never run),
 *   - stays effective until explicitly released by the user.
 *
 * Triggers live in the MAIN process only (global hotkey / tray). Renderer
 * paths may *request* nothing — the switch is deliberately not reachable from
 * the renderer alone, so a hung/hostile renderer cannot enable or disable it.
 */

function createKillSwitch(onChange) {
  let engaged = false;
  let engagedSince = null;
  let lastReason = null;

  const listeners = new Set(
    typeof onChange === "function" ? [onChange] : []
  );

  function notify() {
    for (const fn of listeners) {
      try {
        fn({ engaged, engagedSince, lastReason });
      } catch (err) {
        /* listener failures must never affect the switch */
      }
    }
  }

  return {
    engage(reason = "unknown") {
      if (engaged) return { engaged, lastReason };
      engaged = true;
      engagedSince = Date.now();
      lastReason = reason;
      notify();
      return { engaged, lastReason };
    },

    release(reason = "unknown") {
      if (!engaged) return { engaged, lastReason };
      engaged = false;
      engagedSince = null;
      lastReason = reason;
      notify();
      return { engaged, lastReason };
    },

    toggle(reason = "toggle") {
      return engaged ? this.release(reason) : this.engage(reason);
    },

    isActive() {
      return engaged;
    },

    status() {
      return { engaged, engagedSince, lastReason };
    },

    addListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

module.exports = { createKillSwitch };
