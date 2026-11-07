"use strict";

/**
 * Regression tests for browserControl action-name resolution.
 *
 * Background: Gemini Live sometimes emits { action: "pause" } or
 * { action: "resume" } instead of the canonical
 * { action: "playPause", state: "pause" | "play" }. The controller used to
 * reject those as unsupportedAction, so the video never paused even though the
 * tool call was authorized and executed. These tests pin the mapping without
 * launching a browser.
 */

const assert = require("assert");
const {
  BROWSER_ACTIONS,
  normalizePlaybackState,
  resolveBrowserAction,
} = require("../electron/lib/browserControl.cjs");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✔ " + name);
  } catch (err) {
    console.error("  ✘ " + name);
    throw err;
  }
}

console.log("[TEST] browserControl action resolution");

check("pause aliases resolve to playPause + state 'pause'", () => {
  for (const action of ["pause", "Pause", "PAUSED", "stop", "stopVideo", "pauseVideo"]) {
    assert.deepStrictEqual(resolveBrowserAction({ action }), {
      action: "playPause",
      state: "pause",
    }, action);
  }
});

check("play/resume aliases resolve to playPause + state 'play'", () => {
  for (const action of [
    "play",
    "Play",
    "resume",
    "unpause",
    "continue",
    "start",
    "startVideo",
    "playVideo",
  ]) {
    assert.deepStrictEqual(resolveBrowserAction({ action }), {
      action: "playPause",
      state: "play",
    }, action);
  }
});

check("toggle aliases resolve to playPause + state 'toggle'", () => {
  for (const action of ["toggle", "togglePlay", "togglePause"]) {
    assert.deepStrictEqual(resolveBrowserAction({ action }), {
      action: "playPause",
      state: "toggle",
    }, action);
  }
});

check("canonical playPause keeps an explicit, case-insensitive state", () => {
  assert.deepStrictEqual(resolveBrowserAction({ action: "playPause", state: "pause" }), {
    action: "playPause",
    state: "pause",
  });
  assert.deepStrictEqual(resolveBrowserAction({ action: "playPause", state: "PAUSE" }), {
    action: "playPause",
    state: "pause",
  });
  assert.deepStrictEqual(resolveBrowserAction({ action: "playPause", state: "paused" }), {
    action: "playPause",
    state: "pause",
  });
  assert.deepStrictEqual(resolveBrowserAction({ action: "playPause", state: "resume" }), {
    action: "playPause",
    state: "play",
  });
  assert.deepStrictEqual(resolveBrowserAction({ action: "playPause", state: "playing" }), {
    action: "playPause",
    state: "play",
  });
});

check("bare playPause still defaults to toggle", () => {
  assert.deepStrictEqual(resolveBrowserAction({ action: "playPause" }), {
    action: "playPause",
    state: "toggle",
  });
  assert.deepStrictEqual(resolveBrowserAction({ action: "playpause", state: "bogus" }), {
    action: "playPause",
    state: "toggle",
  });
});

check("existing action aliases are unchanged", () => {
  assert.deepStrictEqual(resolveBrowserAction({ action: "next" }), {
    action: "nextShort",
    state: null,
  });
  assert.deepStrictEqual(resolveBrowserAction({ action: "prev" }), {
    action: "previousShort",
    state: null,
  });
  assert.deepStrictEqual(resolveBrowserAction({ action: "louder" }), {
    action: "increaseVolume",
    state: null,
  });
  assert.deepStrictEqual(resolveBrowserAction({ action: "replay" }), {
    action: "restart",
    state: null,
  });
  assert.deepStrictEqual(resolveBrowserAction({ action: "unmaximize" }), {
    action: "restore",
    state: null,
  });
  assert.deepStrictEqual(resolveBrowserAction({ action: "closeBrowser" }), {
    action: "close",
    state: null,
  });
});

check("bare volume is a query; volume with a level is an absolute set", () => {
  assert.deepStrictEqual(resolveBrowserAction({ action: "volume" }), {
    action: "getVolume",
    state: null,
  });
  assert.deepStrictEqual(resolveBrowserAction({ action: "volume", level: 50 }), {
    action: "setVolume",
    state: null,
  });
});

check("every resolved action is a supported BROWSER_ACTION", () => {
  const actions = [
    "pause",
    "play",
    "resume",
    "toggle",
    "playPause",
    "next",
    "scroll",
    "close",
    "maximize",
    "restore",
    "volume",
  ];
  for (const action of actions) {
    assert.ok(
      BROWSER_ACTIONS.has(resolveBrowserAction({ action }).action),
      action + " resolved to an unsupported action"
    );
  }
});

check("normalizePlaybackState handles null/unknown", () => {
  assert.strictEqual(normalizePlaybackState(undefined), null);
  assert.strictEqual(normalizePlaybackState(""), null);
  assert.strictEqual(normalizePlaybackState("sideways"), null);
  assert.strictEqual(normalizePlaybackState("PAUSE"), "pause");
  assert.strictEqual(normalizePlaybackState("Resume"), "play");
});

console.log(`\n✔ browserActionResolve: ${passed} checks passed`);
