"use strict";

/**
 * Myra AI — Multi-step desktop task runner (Phase 3, ELECTRON MAIN ONLY).
 *
 * A multi-step task is planned first, then executed ONE STEP AT A TIME:
 *
 *   plan(steps)  -> validates every step against the app allowlist and the real
 *                   filesystem, resolves the concrete app keys and folder paths,
 *                   and returns a one-time planId. NOTHING is executed.
 *   run(planId)  -> executes the stored steps sequentially. Each step must
 *                   report ok:true (the underlying appControl action verifies
 *                   its own outcome) before the next step starts. A failed step
 *                   stops the task and is reported honestly.
 *   status()     -> what Myra is doing right now (step by step).
 *   cancel()     -> stop before the next step.
 *
 * Safety properties:
 *  - Steps are a CLOSED set of desktop actions. Arbitrary commands, scripts and
 *    shell strings are structurally impossible: the model can only name a step
 *    type plus an allowlisted app / validated URL / existing folder.
 *  - Destructive steps (closing an app) require confirmDestructive:true on run.
 *    Their close approvals are minted HERE at plan time and are never exposed
 *    to the model, so the model cannot skip the confirmation gate.
 *  - Bounded recovery: at most ONE retry per step, only for transient window
 *    errors, with a fixed delay. No unbounded loops, ever.
 *  - A per-step timeout and a whole-task deadline keep the run inside the
 *    server's registration window.
 */

const crypto = require("crypto");
const fs = require("fs");
const { validateWebUrl, validateFolderPath } = require("./appControl.cjs");
const { normalizeProcessName } = require("./appCatalog.cjs");

const MAX_STEPS = 8;
const MAX_STEP_ATTEMPTS = 2;
const MAX_QUERY_CHARS = 200;
const MAX_PLANS = 6;

const STEP_TYPES = new Set([
  "launchApp",
  "focusApp",
  "windowAction",
  "openUrl",
  "openSearch",
  "openFolder",
  "closeApp",
  "wait",
]);

const WINDOW_ACTION_TYPES = new Set(["minimize", "maximize", "restore"]);
const DESTRUCTIVE_TYPES = new Set(["closeApp"]);

// Only transient window/visibility failures are retried. Launch and close are
// never retried (a second launch could open a duplicate, a second close is
// pointless), and unknown errors fail fast.
const RETRYABLE_ERRORS = new Set(["focusBlocked", "windowStateUnchanged", "noVisibleWindow"]);

const DEFAULT_TIMEOUTS = Object.freeze({
  stepTimeoutMs: 25000,
  maxTaskMs: 150000,
  retryDelayMs: 700,
  planTtlMs: 300000,
});

function pathInfoDefault(target) {
  try {
    const stat = fs.statSync(target);
    return { exists: true, isDirectory: stat.isDirectory() };
  } catch {
    return { exists: false, isDirectory: false };
  }
}

function createTaskRunner(options = {}) {
  const {
    audit = () => {},
    log = () => {},
    app,
    project = null,
    killSwitch = null,
    onState = null,
    deps = {},
    timeouts = {},
  } = options;

  const record = typeof audit === "function" ? audit : () => {};
  const emit = typeof log === "function" ? log : () => {};
  const t = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;
  const pathInfo = deps.pathInfo || pathInfoDefault;

  if (!app || typeof app.run !== "function" || typeof app.inspectApp !== "function") {
    throw new Error("createTaskRunner: an app controller (run + inspectApp) is required");
  }

  const plans = new Map(); // planId -> stored plan (approvals are internal)
  let task = null; // last/current task snapshot
  let cancelled = false;
  let cancelReason = null;

  // -- helpers -------------------------------------------------------------

  function prunePlans() {
    const nowMs = now();
    // Expired plans are dropped. Used plans are KEPT (bounded by MAX_PLANS) so a
    // repeat call reports "planAlreadyUsed" instead of a vague "unknownPlan".
    for (const [id, stored] of plans) {
      if (stored.expiresAt < nowMs) plans.delete(id);
    }
    while (plans.size > MAX_PLANS) {
      const oldest = plans.keys().next().value;
      if (oldest === undefined) break;
      plans.delete(oldest);
    }
  }

  function publish() {
    if (typeof onState !== "function") return;
    try {
      onState(snapshot());
    } catch {
      /* UI/progress failures must never break a task */
    }
  }

  function publicStep(step) {
    return {
      index: step.index,
      type: step.type,
      summary: step.summary,
      state: step.state,
      detail: step.detail || null,
      error: step.error || null,
      attempts: step.attempts || 0,
    };
  }

  function snapshot() {
    if (!task) {
      return {
        ok: true,
        action: "status",
        state: "idle",
        taskId: null,
        planId: null,
        currentIndex: -1,
        current: null,
        steps: [],
        completedCount: 0,
        failedCount: 0,
        detail: "Myra is not running a desktop task right now.",
      };
    }
    const steps = task.steps.map(publicStep);
    const completedCount = steps.filter((step) => step.state === "done").length;
    const failedCount = steps.filter((step) => step.state === "failed").length;
    const current =
      task.currentIndex >= 0 && task.steps[task.currentIndex]
        ? publicStep(task.steps[task.currentIndex])
        : null;

    return {
      ok: true,
      action: "status",
      state: task.state,
      taskId: task.id,
      planId: task.planId,
      currentIndex: task.currentIndex,
      current,
      steps,
      completedCount,
      failedCount,
      total: steps.length,
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
      finishedAt: task.finishedAt ? new Date(task.finishedAt).toISOString() : null,
      error: task.error || null,
      detail:
        task.state === "running" && current
          ? "Myra is on step " + (current.index + 1) + " of " + steps.length + ": " + current.summary
          : task.detail || null,
    };
  }

  function withTimeout(promise, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({
          ok: false,
          error: "stepTimeout",
          detail: "The step did not finish within " + Math.round(timeoutMs / 1000) + "s.",
        });
      }, timeoutMs);
      Promise.resolve(promise).then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            ok: false,
            error: "stepError",
            detail: String((err && err.message) || "step failed").slice(0, 160),
          });
        }
      );
    });
  }

  // -- plan ----------------------------------------------------------------

  async function inspectAppRef(rawApp, index, label) {
    const appRef = typeof rawApp === "string" ? rawApp.trim() : "";
    if (!appRef) {
      return {
        ok: false,
        error: "missingApp",
        step: index,
        detail: "Step " + (index + 1) + " (" + label + ") needs an app name.",
      };
    }
    let inspected;
    try {
      inspected = await app.inspectApp(appRef);
    } catch {
      return {
        ok: false,
        error: "appInspectionFailed",
        step: index,
        detail: "Step " + (index + 1) + ": Myra could not check that app.",
      };
    }
    if (!inspected || inspected.ok !== true) {
      const failure = {
        ok: false,
        error: (inspected && inspected.error) || "appUnavailable",
        step: index,
        detail: (inspected && inspected.detail) || "Step " + (index + 1) + ": that app is not usable.",
      };
      if (inspected && inspected.candidates) failure.candidates = inspected.candidates;
      if (inspected && inspected.suggestions) failure.suggestions = inspected.suggestions;
      return failure;
    }
    return { ok: true, inspected };
  }

  async function buildStep(raw, index, earlierLaunches) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        ok: false,
        error: "malformedStep",
        step: index,
        detail: "Step " + (index + 1) + " is not a valid step.",
      };
    }
    const type = String(raw.type || "").trim();
    if (!STEP_TYPES.has(type)) {
      return {
        ok: false,
        error: "unsupportedStepType",
        step: index,
        detail:
          "Step " +
          (index + 1) +
          ': "' +
          type.slice(0, 40) +
          '" is not a task step Myra supports.',
      };
    }

    if (type === "wait") {
      const seconds = Math.min(Math.max(Number(raw.seconds) || 1, 0.2), 10);
      return {
        ok: true,
        step: {
          index,
          type,
          seconds,
          summary: "Wait " + seconds + "s",
          destructive: false,
        },
      };
    }

    const inspectedResult = await inspectAppRef(raw.app, index, type);
    if (!inspectedResult.ok) return inspectedResult;
    const inspected = inspectedResult.inspected;
    const appKey = inspected.app.key;
    const appTitle = inspected.app.title;
    const baseStep = {
      index,
      type,
      app: { key: appKey, title: appTitle },
      appKey,
      destructive: DESTRUCTIVE_TYPES.has(type),
    };

    const requireRunning = () => {
      if (inspected.running === true) return null;
      if (earlierLaunches.has(appKey)) return null; // a previous step starts it
      return {
        ok: false,
        error: "appNotRunning",
        step: index,
        detail:
          appTitle +
          " is not running yet. Add a launch step for it earlier in the task, or ask the user to open it first.",
      };
    };

    if (type === "launchApp") {
      return {
        ok: true,
        step: { ...baseStep, summary: "Launch " + appTitle, destructive: false },
      };
    }

    if (type === "focusApp") {
      const notRunning = requireRunning();
      if (notRunning) return notRunning;
      return {
        ok: true,
        step: { ...baseStep, summary: "Bring " + appTitle + " to the front", destructive: false },
      };
    }

    if (type === "windowAction") {
      const action = String(raw.action || "").trim();
      if (!WINDOW_ACTION_TYPES.has(action)) {
        return {
          ok: false,
          error: "unsupportedWindowAction",
          step: index,
          detail: 'Step ' + (index + 1) + ": window action must be minimize, maximize or restore.",
        };
      }
      const notRunning = requireRunning();
      if (notRunning) return notRunning;
      return {
        ok: true,
        step: {
          ...baseStep,
          action,
          summary: action.charAt(0).toUpperCase() + action.slice(1) + " " + appTitle,
          destructive: false,
        },
      };
    }

    if (type === "openUrl") {
      if (inspected.browser !== true) {
        return {
          ok: false,
          error: "notABrowser",
          step: index,
          app: inspected.app,
          detail: appTitle + " is not a browser Myra can send a URL to.",
        };
      }
      const check = validateWebUrl(raw.url);
      if (!check.ok) {
        return {
          ok: false,
          error: check.reason,
          step: index,
          detail: "Step " + (index + 1) + " needs a normal http/https address.",
        };
      }
      return {
        ok: true,
        step: {
          ...baseStep,
          url: check.url,
          summary: "Open " + check.url + " in " + appTitle,
          destructive: false,
        },
      };
    }

    if (type === "openSearch") {
      if (inspected.browser !== true) {
        return {
          ok: false,
          error: "notABrowser",
          step: index,
          app: inspected.app,
          detail: appTitle + " is not a browser Myra can search in.",
        };
      }
      const query = typeof raw.query === "string" ? raw.query.trim() : "";
      if (!query || query.length > MAX_QUERY_CHARS) {
        return {
          ok: false,
          error: "invalidQuery",
          step: index,
          detail: "Step " + (index + 1) + " needs a search text (up to 200 characters).",
        };
      }
      return {
        ok: true,
        step: {
          ...baseStep,
          query,
          summary: 'Search "' + query.slice(0, 60) + '" in ' + appTitle,
          destructive: false,
        },
      };
    }

    if (type === "openFolder") {
      if (inspected.supportsFolder !== true) {
        return {
          ok: false,
          error: "notAFolderTarget",
          step: index,
          app: inspected.app,
          detail: appTitle + " cannot open a project folder for Myra.",
        };
      }
      let folder = typeof raw.folder === "string" ? raw.folder.trim() : "";
      if (!folder) {
        let detected = null;
        try {
          detected = project && typeof project.detect === "function" ? await project.detect() : null;
        } catch {
          detected = null;
        }
        if (!detected || detected.ok !== true || !detected.root) {
          return {
            ok: false,
            error: "noActiveProjectFolder",
            step: index,
            detail:
              "Myra could not detect an active project folder. Ask the user for the full folder path, or ask them to open it once.",
          };
        }
        folder = detected.root;
      }
      const folderCheck = validateFolderPath(folder, pathInfo);
      if (!folderCheck.ok) {
        return {
          ok: false,
          error: folderCheck.reason,
          step: index,
          detail: "Step " + (index + 1) + ": that folder is not usable.",
        };
      }
      return {
        ok: true,
        step: {
          ...baseStep,
          folder: folderCheck.path,
          summary: "Open folder " + folderCheck.name + " in " + appTitle,
          destructive: false,
        },
      };
    }

    // closeApp (the only destructive type)
    if (inspected.closeable !== true) {
      return {
        ok: false,
        error: "closeNotPermitted",
        step: index,
        app: inspected.app,
        detail: appTitle + " is part of the Windows shell; Myra will not close it.",
      };
    }
    const notRunning = requireRunning();
    if (notRunning) return notRunning;

    const approvalId =
      typeof app.mintCloseApproval === "function" ? app.mintCloseApproval(appKey) : null;
    if (!approvalId) {
      return {
        ok: false,
        error: "closeNotPermitted",
        step: index,
        app: inspected.app,
        detail: "Myra could not prepare a close approval for " + appTitle + ".",
      };
    }
    return {
      ok: true,
      step: {
        ...baseStep,
        approvalId,
        summary: "Close " + appTitle + " (needs your confirmation)",
        destructive: true,
      },
    };
  }

  async function plan(rawArgs) {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    const rawSteps = Array.isArray(args.steps) ? args.steps : [];

    if (rawSteps.length === 0) {
      return {
        ok: false,
        action: "plan",
        error: "emptySteps",
        detail: "Give Myra the steps for the task (for example launchApp then openFolder).",
      };
    }
    if (rawSteps.length > MAX_STEPS) {
      return {
        ok: false,
        action: "plan",
        error: "tooManySteps",
        detail: "A task can have at most " + MAX_STEPS + " steps; split it into two smaller tasks.",
      };
    }

    const built = [];
    const earlierLaunches = new Set();
    for (let i = 0; i < rawSteps.length; i++) {
      const result = await buildStep(rawSteps[i], i, earlierLaunches);
      if (!result.ok) return { ...result, action: "plan" };
      built.push(result.step);
      if (result.step.type === "launchApp") earlierLaunches.add(result.step.appKey);
    }

    const destructiveSteps = built.filter((step) => step.destructive);
    const planId = crypto.randomBytes(16).toString("hex");
    prunePlans();
    plans.set(planId, {
      planId,
      steps: built,
      destructive: destructiveSteps.length > 0,
      createdAt: now(),
      expiresAt: now() + t.planTtlMs,
      used: false,
    });
    record("TASK_PLAN_CREATED", { tool: "taskControl", step: built.length });

    const listed = built.map((step) => (step.index + 1) + ". " + step.summary).join("\n");
    return {
      ok: true,
      action: "plan",
      planId,
      steps: built.map((step) => ({
        index: step.index,
        type: step.type,
        summary: step.summary,
        destructive: step.destructive,
        app: step.app || null,
      })),
      stepCount: built.length,
      destructiveCount: destructiveSteps.length,
      requiresConfirmation: destructiveSteps.length > 0,
      summary: listed,
      expiresInSeconds: Math.round(t.planTtlMs / 1000),
      detail:
        "Nothing has been started yet. Read these steps to the user" +
        (destructiveSteps.length > 0
          ? ", ask for an explicit yes for the destructive step(s), then call run with this planId and confirmDestructive:true."
          : ", then call run with this planId."),
    };
  }

  // -- execution -----------------------------------------------------------

  async function executeStep(step) {
    switch (step.type) {
      case "launchApp":
        return app.run({ action: "launch", app: step.appKey });
      case "focusApp":
        return app.run({ action: "focus", app: step.appKey });
      case "windowAction":
        return app.run({ action: step.action, app: step.appKey });
      case "openUrl":
        return app.run({ action: "openUrl", app: step.appKey, url: step.url });
      case "openSearch":
        return app.run({ action: "openSearch", app: step.appKey, query: step.query });
      case "openFolder":
        return app.run({ action: "openFolder", app: step.appKey, folder: step.folder });
      case "closeApp":
        return app.run({ action: "close", app: step.appKey, approvalId: step.approvalId });
      case "wait":
        await sleep(Math.round(step.seconds * 1000));
        return { ok: true, verified: true, detail: "Waited " + step.seconds + "s." };
      default:
        return { ok: false, error: "unsupportedStepType", detail: "That step type is not supported." };
    }
  }

  function killSwitchActive() {
    return Boolean(killSwitch && typeof killSwitch.isActive === "function" && killSwitch.isActive());
  }

  async function run(rawArgs) {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    const planId = typeof args.planId === "string" ? args.planId.trim() : "";

    if (!planId) {
      return {
        ok: false,
        action: "run",
        error: "missingPlanId",
        detail: "Call action 'plan' first, then run the planId it returns.",
      };
    }
    prunePlans();
    const stored = plans.get(planId);
    if (!stored) {
      return {
        ok: false,
        action: "run",
        error: "unknownPlan",
        detail: "That task plan is unknown or expired. Plan the steps again.",
      };
    }
    if (stored.used) {
      return {
        ok: false,
        action: "run",
        error: "planAlreadyUsed",
        detail: "That plan already ran. Plan again if the user wants a repeat.",
      };
    }
    if (stored.expiresAt < now()) {
      plans.delete(planId);
      return {
        ok: false,
        action: "run",
        error: "planExpired",
        detail: "That plan expired. Plan the steps again.",
      };
    }
    if (killSwitchActive()) {
      record("TASK_RUN_DENIED", { tool: "taskControl", reason: "killSwitchActive" });
      return {
        ok: false,
        action: "run",
        error: "killSwitchActive",
        detail: "The kill switch is engaged; Myra will not start a task.",
      };
    }
    if (task && task.state === "running") {
      return {
        ok: false,
        action: "run",
        error: "taskBusy",
        detail: "Myra is already running a task.",
        current: snapshot(),
      };
    }
    if (stored.destructive && args.confirmDestructive !== true) {
      record("TASK_RUN_DENIED", { tool: "taskControl", reason: "confirmationRequired" });
      return {
        ok: false,
        action: "run",
        planId,
        error: "confirmationRequired",
        requiresConfirmation: true,
        destructiveSteps: stored.steps
          .filter((step) => step.destructive)
          .map((step) => ({ index: step.index, summary: step.summary })),
        detail:
          "This plan closes an app. Read those steps to the user, get an explicit yes, then call run again with confirmDestructive:true.",
      };
    }

    stored.used = true; // single use, consumed before any side effect
    const startedMs = now();
    cancelled = false;
    cancelReason = null;

    task = {
      id: crypto.randomBytes(8).toString("hex"),
      planId,
      state: "running",
      startedAt: startedMs,
      finishedAt: null,
      currentIndex: -1,
      error: null,
      detail: null,
      steps: stored.steps.map((step) => ({
        index: step.index,
        type: step.type,
        summary: step.summary,
        state: "pending",
        detail: null,
        error: null,
        attempts: 0,
      })),
    };

    record("TASK_RUN_STARTED", { tool: "taskControl", step: stored.steps.length });
    publish();

    let failure = null;

    for (let i = 0; i < stored.steps.length; i++) {
      const step = stored.steps[i];
      const live = task.steps[i];

      if (cancelled) {
        live.state = "skipped";
        continue;
      }
      if (killSwitchActive()) {
        cancelled = true;
        cancelReason = "killSwitch";
        live.state = "skipped";
        continue;
      }
      if (now() - startedMs > t.maxTaskMs) {
        live.state = "failed";
        live.error = "taskTimeout";
        live.detail = "The task ran too long and was stopped.";
        failure = {
          index: i,
          error: "taskTimeout",
          detail: "The whole task exceeded " + Math.round(t.maxTaskMs / 1000) + "s.",
        };
        record("TASK_STEP_FAILED", { tool: "taskControl", step: live.index, reason: "taskTimeout" });
        break;
      }

      task.currentIndex = i;
      live.state = "running";
      publish();

      let result = null;
      let attempts = 0;
      for (;;) {
        attempts++;
        result = await withTimeout(executeStep(step), t.stepTimeoutMs);
        if (result && result.ok === true) break;
        const error = (result && result.error) || "stepFailed";
        if (attempts >= MAX_STEP_ATTEMPTS || !RETRYABLE_ERRORS.has(error)) break;
        record("TASK_STEP_RETRY", { tool: "taskControl", step: live.index, reason: error });
        await sleep(t.retryDelayMs);
        if (cancelled || killSwitchActive()) break;
      }

      live.attempts = attempts;

      if (result && result.ok === true) {
        // A step that already succeeded stays successful even if a cancel or the
        // kill switch arrived while it was in flight; the loop stops before the
        // NEXT step.
        live.state = "done";
        live.detail = String((result && result.detail) || "").slice(0, 160) || null;
        record("TASK_STEP_OK", { tool: "taskControl", step: live.index });
        continue;
      }

      if (cancelled) {
        live.state = "skipped";
        continue;
      }

      live.state = "failed";
      live.error = String((result && result.error) || "stepFailed").slice(0, 60);
      live.detail = String((result && result.detail) || "").slice(0, 160) || null;
      record("TASK_STEP_FAILED", { tool: "taskControl", step: live.index, reason: live.error });
      failure = {
        index: i,
        error: live.error,
        detail: live.detail,
      };
      break;
    }

    for (const live of task.steps) {
      if (live.state === "pending") live.state = "skipped";
    }

    task.finishedAt = now();
    task.currentIndex = -1;
    const completedCount = task.steps.filter((step) => step.state === "done").length;

    if (cancelled) {
      task.state = "cancelled";
      task.error = cancelReason || "cancelled";
      task.detail =
        "Task cancelled after " + completedCount + " of " + task.steps.length + " step(s).";
    } else if (failure) {
      task.state = "failed";
      task.error = failure.error;
      const failedStep = task.steps[failure.index];
      task.detail =
        "Step " +
        (failure.index + 1) +
        " (" +
        (failedStep ? failedStep.summary : "step") +
        ") failed: " +
        failure.error +
        (failure.detail ? " — " + failure.detail : "");
    } else if (completedCount === task.steps.length) {
      task.state = "completed";
      task.detail = "All " + task.steps.length + " step(s) completed and verified.";
    } else {
      task.state = "failed";
      task.error = "incompleteTask";
      task.detail = "Only " + completedCount + " of " + task.steps.length + " step(s) completed.";
    }

    publish();
    record(task.state === "completed" ? "TASK_COMPLETED" : "TASK_FAILED", {
      tool: "taskControl",
      reason: task.error || "completed",
    });

    if (task.state === "running") {
      // Defensive: the loop always terminates with a terminal state.
      task.state = "failed";
      task.error = "internalError";
    }

    emit("task", task.id, task.state, task.detail || "");

    const finished = {
      ok: task.state === "completed",
      action: "run",
      taskId: task.id,
      planId,
      state: task.state,
      completed: completedCount,
      total: task.steps.length,
      steps: task.steps.map(publicStep),
      durationMs: task.finishedAt - task.startedAt,
      detail: task.detail,
    };
    if (failure) {
      finished.failedStep = publicStep(task.steps[failure.index]);
    }
    if (task.state === "cancelled") {
      finished.reason = task.error;
    }
    return finished;
  }

  function status() {
    return snapshot();
  }

  function cancel(reason) {
    const why = String(reason == null ? "user" : reason).slice(0, 40);
    if (!task || task.state !== "running") {
      return {
        ok: true,
        action: "cancel",
        cancelled: false,
        state: task ? task.state : "idle",
        detail: "Nothing is running.",
      };
    }
    cancelled = true;
    cancelReason = why;
    record("TASK_CANCEL_REQUESTED", { tool: "taskControl", reason: why });
    return {
      ok: true,
      action: "cancel",
      cancelled: true,
      state: "running",
      taskId: task.id,
      detail: "Myra will stop before the next step.",
    };
  }

  return {
    plan,
    run,
    status,
    cancel,
    /** Everything below is for tests/diagnostics. */
    dispose: () => {
      cancelled = true;
      plans.clear();
      task = null;
    },
    pendingPlans: () => plans.size,
    isRunning: () => Boolean(task && task.state === "running"),
  };
}

module.exports = {
  createTaskRunner,
  STEP_TYPES,
  WINDOW_ACTION_TYPES,
  DESTRUCTIVE_TYPES,
  MAX_STEPS,
  MAX_STEP_ATTEMPTS,
};
