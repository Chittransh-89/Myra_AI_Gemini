"use strict";

/**
 * Myra AI — Phase 3 multi-step task runner tests.
 *
 * The runner is exercised with a stub app controller so execution order,
 * verification gating, retry bounds, cancellation and confirmation can be
 * asserted deterministically (no real app is launched).
 */

const assert = require("assert");
const { createTaskRunner, MAX_STEPS } = require("../electron/lib/taskRunner.cjs");

const APPROVAL = "a".repeat(32);

const INSPECTIONS = {
  vscode: {
    ok: true,
    app: { key: "vscode", title: "Visual Studio Code" },
    installed: true,
    running: false,
    closeable: true,
    browser: false,
    supportsFolder: true,
  },
  chrome: {
    ok: true,
    app: { key: "chrome", title: "Google Chrome" },
    installed: true,
    running: false,
    closeable: true,
    browser: true,
    supportsFolder: false,
  },
  notepad: {
    ok: true,
    app: { key: "notepad", title: "Notepad" },
    installed: true,
    running: true,
    closeable: true,
    browser: false,
    supportsFolder: false,
  },
  fileexplorer: {
    ok: true,
    app: { key: "fileexplorer", title: "File Explorer" },
    installed: true,
    running: true,
    closeable: false,
    browser: false,
    supportsFolder: true,
  },
};

function createApp(options = {}) {
  const calls = [];
  const inspections = options.inspections || INSPECTIONS;
  const handler = options.handler || (() => ({ ok: true, verified: true, detail: "done" }));
  return {
    calls,
    inspectApp: async (name) => {
      const entry = inspections[name];
      if (!entry) {
        return { ok: false, error: "appNotInAllowlist", detail: name + " is not allowlisted", suggestions: [] };
      }
      return entry;
    },
    run: async (args) => {
      calls.push(args);
      return handler(args, calls.length);
    },
    mintCloseApproval: (key) => (options.noApprovals ? null : APPROVAL),
  };
}

function createRunner(app, options = {}) {
  return createTaskRunner({
    audit: () => {},
    log: () => {},
    app,
    project: options.project || null,
    killSwitch: options.killSwitch || null,
    onState: options.onState || null,
    deps: { sleep: (ms) => Promise.resolve(ms), pathInfo: options.pathInfo || (() => ({ exists: true, isDirectory: true })) },
    timeouts: {
      stepTimeoutMs: options.stepTimeoutMs || 2000,
      maxTaskMs: options.maxTaskMs || 10000,
      retryDelayMs: 1,
      planTtlMs: options.planTtlMs || 60000,
    },
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✔ " + name);
  } catch (err) {
    failures.push({ name, err });
    console.error("  ✘ " + name);
    console.error("     " + (err && err.message));
  }
}

async function main() {
  console.log("[TEST] Phase 3 multi-step task runner");

  // -- plan validation ------------------------------------------------------

  await check("plan rejects an empty step list", async () => {
    const runner = createRunner(createApp());
    const res = await runner.plan({ steps: [] });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "emptySteps");
  });

  await check("plan caps the number of steps", async () => {
    const runner = createRunner(createApp());
    const steps = Array.from({ length: MAX_STEPS + 1 }, () => ({ type: "launchApp", app: "vscode" }));
    const res = await runner.plan({ steps });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "tooManySteps");
  });

  await check("plan rejects unknown step types and malformed steps", async () => {
    const runner = createRunner(createApp());
    const unknown = await runner.plan({ steps: [{ type: "runShellCommand", command: "dir" }] });
    assert.strictEqual(unknown.ok, false);
    assert.strictEqual(unknown.error, "unsupportedStepType");

    const malformed = await runner.plan({ steps: ["launchApp vscode"] });
    assert.strictEqual(malformed.error, "malformedStep");
  });

  await check("plan rejects URLs on non-browsers and non-web schemes", async () => {
    const runner = createRunner(createApp());
    const notBrowser = await runner.plan({
      steps: [{ type: "openUrl", app: "notepad", url: "https://example.com" }],
    });
    assert.strictEqual(notBrowser.error, "notABrowser");

    const badScheme = await runner.plan({
      steps: [{ type: "openUrl", app: "chrome", url: "file:///C:/Windows/System32/calc.exe" }],
    });
    assert.strictEqual(badScheme.error, "unsupportedUrl");
  });

  await check("plan explains an app it may not control", async () => {
    const runner = createRunner(createApp());
    const res = await runner.plan({ steps: [{ type: "launchApp", app: "photoshop" }] });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "appNotInAllowlist");
    assert.strictEqual(res.step, 0);
  });

  await check("plan requires the target of a window action to be running", async () => {
    const runner = createRunner(createApp());
    const res = await runner.plan({ steps: [{ type: "minimize", app: "chrome" }] });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "unsupportedStepType");

    const notRunning = await runner.plan({
      steps: [{ type: "windowAction", app: "chrome", action: "minimize" }],
    });
    assert.strictEqual(notRunning.ok, false);
    assert.strictEqual(notRunning.error, "appNotRunning");

    const allowed = await runner.plan({
      steps: [
        { type: "launchApp", app: "chrome" },
        { type: "windowAction", app: "chrome", action: "minimize" },
      ],
    });
    assert.strictEqual(allowed.ok, true, JSON.stringify(allowed));
  });

  await check("plan marks closeApp destructive and hides the internal approval", async () => {
    const runner = createRunner(createApp());
    const res = await runner.plan({
      steps: [
        { type: "launchApp", app: "vscode" },
        { type: "closeApp", app: "notepad" },
      ],
    });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.requiresConfirmation, true);
    assert.strictEqual(res.destructiveCount, 1);
    assert.strictEqual(res.steps[1].destructive, true);
    const serialised = JSON.stringify(res);
    assert.ok(!serialised.includes(APPROVAL), "the close approval must never reach the model");
    assert.ok(!serialised.includes("approvalId"), "the plan must not expose approvalIds");
  });

  await check("plan refuses to close the Windows shell", async () => {
    const runner = createRunner(createApp());
    const res = await runner.plan({ steps: [{ type: "closeApp", app: "fileexplorer" }] });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "closeNotPermitted");
  });

  await check("plan refuses to close an app that is not running", async () => {
    const runner = createRunner(createApp());
    const res = await runner.plan({ steps: [{ type: "closeApp", app: "chrome" }] });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "appNotRunning");
  });

  await check("plan resolves the active project folder when none is given", async () => {
    const runner = createRunner(createApp(), {
      project: { detect: async () => ({ ok: true, root: "C:\\work\\myproj", name: "myproj" }) },
    });
    const res = await runner.plan({ steps: [{ type: "openFolder", app: "vscode" }] });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.ok(res.steps[0].summary.includes("myproj"), res.steps[0].summary);
  });

  await check("plan explains a missing project folder and a bad explicit folder", async () => {
    const noProject = createRunner(createApp());
    const res = await noProject.plan({ steps: [{ type: "openFolder", app: "vscode" }] });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "noActiveProjectFolder");

    const badFolder = createRunner(createApp(), {
      pathInfo: () => ({ exists: false, isDirectory: false }),
    });
    const missing = await badFolder.plan({
      steps: [{ type: "openFolder", app: "vscode", folder: "C:\\nope" }],
    });
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.error, "folderNotFound");
  });

  // -- run gating -----------------------------------------------------------

  await check("run needs a real planId", async () => {
    const runner = createRunner(createApp());
    const missing = await runner.run({});
    assert.strictEqual(missing.error, "missingPlanId");
    const unknown = await runner.run({ planId: "f".repeat(32) });
    assert.strictEqual(unknown.error, "unknownPlan");
  });

  await check("a destructive plan cannot run without explicit confirmation", async () => {
    const app = createApp();
    const runner = createRunner(app);
    const planned = await runner.plan({ steps: [{ type: "closeApp", app: "notepad" }] });
    assert.strictEqual(planned.ok, true);

    const refused = await runner.run({ planId: planned.planId });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.error, "confirmationRequired");
    assert.strictEqual(refused.requiresConfirmation, true);
    assert.strictEqual(app.calls.length, 0, "nothing may execute before confirmation");

    const confirmed = await runner.run({
      planId: planned.planId,
      confirmDestructive: true,
    });
    assert.strictEqual(confirmed.ok, true, JSON.stringify(confirmed));
    assert.deepStrictEqual(app.calls, [
      { action: "close", app: "notepad", approvalId: APPROVAL },
    ]);
  });

  await check("a plan is single-use", async () => {
    const app = createApp();
    const runner = createRunner(app);
    const planned = await runner.plan({ steps: [{ type: "launchApp", app: "vscode" }] });
    const first = await runner.run({ planId: planned.planId });
    assert.strictEqual(first.ok, true);

    const second = await runner.run({ planId: planned.planId });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.error, "planAlreadyUsed");
    assert.strictEqual(app.calls.length, 1);
  });

  await check("an engaged kill switch blocks a task", async () => {
    const app = createApp();
    const runner = createRunner(app, { killSwitch: { isActive: () => true } });
    const planned = await runner.plan({ steps: [{ type: "launchApp", app: "vscode" }] });
    assert.strictEqual(planned.ok, true);

    const res = await runner.run({ planId: planned.planId });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "killSwitchActive");
    assert.strictEqual(app.calls.length, 0);
  });

  // -- execution ------------------------------------------------------------

  await check("steps run sequentially in plan order", async () => {
    const app = createApp();
    const runner = createRunner(app, {
      project: { detect: async () => ({ ok: true, root: "C:\\work\\myproj", name: "myproj" }) },
    });
    const planned = await runner.plan({
      steps: [
        { type: "launchApp", app: "vscode" },
        { type: "openFolder", app: "vscode" },
      ],
    });
    assert.strictEqual(planned.ok, true);

    const res = await runner.run({ planId: planned.planId });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.state, "completed");
    assert.strictEqual(res.completed, 2);
    assert.deepStrictEqual(
      app.calls.map((call) => call.action),
      ["launch", "openFolder"]
    );
    assert.strictEqual(app.calls[1].folder, "C:\\work\\myproj");
    assert.ok(res.steps.every((step) => step.state === "done"));
  });

  await check("a failed step stops the task and reports exactly where", async () => {
    const app = createApp({
      handler: (args) =>
        args.action === "openFolder"
          ? { ok: false, error: "folderOpenUnverified", detail: "title never matched" }
          : { ok: true, verified: true },
    });
    const runner = createRunner(app, {
      project: { detect: async () => ({ ok: true, root: "C:\\work\\myproj" }) },
    });
    const planned = await runner.plan({
      steps: [
        { type: "launchApp", app: "vscode" },
        { type: "openFolder", app: "vscode" },
        { type: "wait", seconds: 0.2 },
      ],
    });
    const res = await runner.run({ planId: planned.planId });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.state, "failed");
    assert.strictEqual(res.completed, 1);
    assert.strictEqual(res.failedStep.index, 1);
    assert.strictEqual(res.failedStep.error, "folderOpenUnverified");
    assert.strictEqual(res.steps[2].state, "skipped", "later steps must not run");
    assert.ok(res.detail.includes("Step 2"));
    assert.strictEqual(app.calls.length, 2);
  });

  await check("a transient window failure is retried exactly once", async () => {
    let attempts = 0;
    const app = createApp({
      handler: () => {
        attempts++;
        return attempts === 1
          ? { ok: false, error: "windowStateUnchanged" }
          : { ok: true, verified: true, detail: "minimized" };
      },
    });
    const runner = createRunner(app);
    const planned = await runner.plan({
      steps: [{ type: "windowAction", app: "notepad", action: "minimize" }],
    });
    const res = await runner.run({ planId: planned.planId });

    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.steps[0].attempts, 2);
    assert.strictEqual(app.calls.length, 2);
  });

  await check("a non-transient failure is not retried", async () => {
    const app = createApp({
      handler: () => ({ ok: false, error: "launchUnverified", detail: "not confirmed" }),
    });
    const runner = createRunner(app);
    const planned = await runner.plan({ steps: [{ type: "launchApp", app: "vscode" }] });
    const res = await runner.run({ planId: planned.planId });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.steps[0].attempts, 1);
    assert.strictEqual(app.calls.length, 1, "no duplicate launch attempts");
  });

  await check("a hanging step times out instead of blocking forever", async () => {
    const app = createApp({ handler: () => new Promise(() => {}) });
    const runner = createRunner(app, { stepTimeoutMs: 40 });
    const planned = await runner.plan({ steps: [{ type: "launchApp", app: "vscode" }] });
    const res = await runner.run({ planId: planned.planId });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.state, "failed");
    assert.strictEqual(res.failedStep.error, "stepTimeout");
  });

  await check("cancel stops the task before the next step", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const app = createApp({ handler: () => gate.then(() => ({ ok: true, verified: true })) });
    const runner = createRunner(app);
    const planned = await runner.plan({
      steps: [
        { type: "launchApp", app: "vscode" },
        { type: "wait", seconds: 0.2 },
      ],
    });

    const running = runner.run({ planId: planned.planId });
    await sleep(20);
    assert.strictEqual(runner.status().state, "running");

    const cancel = runner.cancel("user");
    assert.strictEqual(cancel.cancelled, true);
    release();

    const res = await running;
    assert.strictEqual(res.state, "cancelled");
    assert.strictEqual(res.steps[0].state, "done", "the in-flight step really did succeed");
    assert.strictEqual(res.steps[1].state, "skipped");
    assert.strictEqual(app.calls.length, 1);
  });

  await check("status reports the live step and the final summary", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const app = createApp({ handler: () => gate.then(() => ({ ok: true, verified: true })) });
    const runner = createRunner(app);

    assert.strictEqual(runner.status().state, "idle");

    const planned = await runner.plan({ steps: [{ type: "launchApp", app: "vscode" }] });
    const running = runner.run({ planId: planned.planId });
    await sleep(20);

    const live = runner.status();
    assert.strictEqual(live.state, "running");
    assert.strictEqual(live.current.index, 0);
    assert.ok(live.detail.includes("step 1 of 1"));

    release();
    const res = await running;
    const done = runner.status();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(done.state, "completed");
    assert.strictEqual(done.completedCount, 1);
  });

  await check("a second task cannot start while one is running", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const app = createApp({ handler: () => gate.then(() => ({ ok: true, verified: true })) });
    const runner = createRunner(app);
    const first = await runner.plan({ steps: [{ type: "launchApp", app: "vscode" }] });
    const second = await runner.plan({ steps: [{ type: "launchApp", app: "chrome" }] });

    const running = runner.run({ planId: first.planId });
    await sleep(20);
    const busy = await runner.run({ planId: second.planId });
    assert.strictEqual(busy.ok, false);
    assert.strictEqual(busy.error, "taskBusy");

    release();
    await running;
  });

  await check("the wait step is bounded and reported", async () => {
    const app = createApp();
    const runner = createRunner(app);
    const planned = await runner.plan({ steps: [{ type: "wait", seconds: 0.2 }] });
    const res = await runner.run({ planId: planned.planId });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(app.calls.length, 0, "a wait step never touches the app controller");
    assert.ok(res.steps[0].detail.includes("Waited"));
  });

  await check("the task state mirror is emitted for the UI", async () => {
    const seen = [];
    const app = createApp();
    const runner = createRunner(app, { onState: (state) => seen.push(state.state) });
    const planned = await runner.plan({ steps: [{ type: "launchApp", app: "vscode" }] });
    await runner.run({ planId: planned.planId });

    assert.ok(seen.includes("running"), JSON.stringify(seen));
    assert.strictEqual(seen[seen.length - 1], "completed");
  });

  console.log("\n==================================================");
  if (failures.length > 0) {
    console.error("  " + failures.length + " TASK RUNNER CHECK(S) FAILED");
    console.log("==================================================");
    process.exit(1);
  }
  console.log("  ALL " + passed + " TASK RUNNER CHECKS PASSED");
  console.log("==================================================");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
