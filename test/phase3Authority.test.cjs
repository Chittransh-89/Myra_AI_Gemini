"use strict";

/**
 * Myra AI — Phase 3 end-to-end wiring + trust-chain tests.
 *
 * Proves that the new desktop automation tools are reachable ONLY through the
 * existing authenticated handoff path:
 *   renderer trigger -> main executor -> verified result -> signed completion.
 *
 * Also pins the static wiring (server declarations, main IPC, preload bridge,
 * UI panel) and the security properties (no shell, no child_process in the task
 * runner, audit fields whitelisted).
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createHandoffAuthority } = require("../electron/lib/handoffAuthority.cjs");
const { createKillSwitch } = require("../electron/lib/killSwitch.cjs");
const { createAppControl } = require("../electron/lib/appControl.cjs");
const { createTaskRunner } = require("../electron/lib/taskRunner.cjs");
const { createAuditLogger, sanitizeField } = require("../electron/lib/auditLogger.cjs");
const { APP_BY_KEY, expandEnvPath } = require("../electron/lib/appCatalog.cjs");
const iv = require("../electron/lib/ipcValidate.cjs");

const SESSION = "phasethreesess01";
const RECEIPT_KEY = crypto.randomBytes(32);
const ENV = {
  SystemRoot: "C:\\Windows",
  LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
  APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
};

const notepadExe = expandEnvPath(APP_BY_KEY.get("notepad").exeCandidates[0], ENV);

function createFakeOs() {
  let procs = [];
  let pidSeq = 7000;
  return {
    procs: () => procs,
    deps: {
      pathInfo: (target) => ({ exists: target === notepadExe, isDirectory: false }),
      readDirNames: () => [],
      listProcesses: async () => procs.map((proc) => ({ name: proc.name, pid: proc.pid })),
      spawnDetached: async () => {
        const pid = ++pidSeq;
        procs = [{ name: "Notepad.exe", pid }];
        return { ok: true, pid };
      },
      killPid: async (pid) => {
        procs = procs.filter((proc) => proc.pid !== pid);
        return { ok: true };
      },
      windows: async () => ({
        ok: true,
        windows: [{ name: "Notepad.exe", pid: 7001, hwnd: 1, iconic: false, zoomed: false }],
      }),
      activeWindow: async () =>
        procs.length > 0
          ? { pid: procs[0].pid, name: "Notepad.exe", title: "Untitled - Notepad" }
          : null,
      windowTitles: async () => procs.map((proc) => ({ name: "Notepad.exe", pid: proc.pid, title: "" })),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    },
  };
}

function buildStack(options = {}) {
  const os1 = createFakeOs();
  const killSwitch = createKillSwitch();
  const completions = [];
  const appControl = createAppControl({
    audit: () => {},
    log: () => {},
    platform: "win32",
    env: ENV,
    deps: os1.deps,
    timeouts: {
      launchVerifyMs: 80,
      launchPollMs: 5,
      closeVerifyMs: 80,
      closePollMs: 5,
      windowRetryMs: 5,
      windowSettleMs: 5,
      folderVerifyMs: 60,
      installCacheMs: 0,
    },
  });
  const taskControl = createTaskRunner({
    audit: () => {},
    log: () => {},
    app: appControl,
    project: { detect: async () => ({ ok: false, error: "noActiveProject" }) },
    killSwitch,
    deps: { sleep: (ms) => Promise.resolve(ms), pathInfo: () => ({ exists: false, isDirectory: false }) },
    timeouts: { stepTimeoutMs: 3000, retryDelayMs: 1 },
  });
  const authority = createHandoffAuthority({
    audit: () => {},
    killSwitch,
    receiptKey: RECEIPT_KEY,
    emitCompletion: (frame) => {
      completions.push(frame);
      return true;
    },
    notifyExecuting: () => {},
    app: options.withApp === false ? undefined : appControl,
    task: options.withTask === false ? undefined : taskControl,
  });
  return { authority, killSwitch, appControl, taskControl, completions, os1 };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function verifyReceipt(receipt) {
  const { sig, ...payload } = receipt;
  const canonical = iv.strictCanonicalJson(payload);
  assert.ok(canonical !== null, "receipt must canonicalise");
  assert.strictEqual(sig, iv.hmacHex(RECEIPT_KEY, iv.COMPLETION_DOMAIN, canonical));
}

function readSource(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

const shell = (relative) => readSource(relative);

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
  console.log("[TEST] Phase 3 trust-chain, wiring & security");

  await check("appControl executes only through a registered, signed ticket", async () => {
    const { authority, completions } = buildStack();
    const args = { action: "list" };

    const reg = authority.registerPendingCall({
      callId: "p3-app-1",
      toolName: "appControl",
      args,
      sessionId: SESSION,
    });
    assert.strictEqual(reg.ok, true, JSON.stringify(reg));
    assert.strictEqual(reg.mainExecuted, true);

    const ack = authority.handleExecuteTool({ ticket: reg.ticket, name: "appControl", args });
    assert.strictEqual(ack.status, "accepted", JSON.stringify(ack));

    assert.ok(await waitFor(() => completions.length === 1), "a completion must arrive");
    const receipt = completions[0].receipt;
    verifyReceipt(receipt);
    assert.strictEqual(receipt.kind, "completion");
    assert.strictEqual(receipt.toolName, "appControl");
    assert.strictEqual(receipt.executionStatus, "success");
    assert.strictEqual(receipt.result.ok, true);
    assert.strictEqual(receipt.result.action, "list");
    assert.ok(Array.isArray(receipt.result.apps));
  });

  await check("the result carries real verification, not a canned success", async () => {
    const { authority, completions } = buildStack();
    const args = { action: "launch", app: "notepad" };

    const reg = authority.registerPendingCall({
      callId: "p3-app-2",
      toolName: "appControl",
      args,
      sessionId: SESSION,
    });
    authority.handleExecuteTool({ ticket: reg.ticket, name: "appControl", args });
    assert.ok(await waitFor(() => completions.length === 1));

    const result = completions[0].receipt.result;
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(result.launched, true);
    assert.strictEqual(result.verified, true);
    assert.strictEqual(result.app.key, "notepad");
  });

  await check("renderer argument tampering is rejected before execution", async () => {
    const { authority } = buildStack();
    const args = { action: "launch", app: "notepad" };
    const reg = authority.registerPendingCall({
      callId: "p3-app-3",
      toolName: "appControl",
      args,
      sessionId: SESSION,
    });
    const tampered = authority.handleExecuteTool({
      ticket: reg.ticket,
      name: "appControl",
      args: { action: "launch", app: "notepad", extra: "C:\\Windows\\System32\\cmd.exe" },
    });
    assert.strictEqual(tampered.status, "denied");
    assert.strictEqual(tampered.reason, "argsTampered");
  });

  await check("a ticket is single-use", async () => {
    const { authority } = buildStack();
    const args = { action: "installed" };
    const reg = authority.registerPendingCall({
      callId: "p3-app-4",
      toolName: "appControl",
      args,
      sessionId: SESSION,
    });
    assert.strictEqual(authority.handleExecuteTool({ ticket: reg.ticket, name: "appControl", args }).status, "accepted");
    const replay = authority.handleExecuteTool({ ticket: reg.ticket, name: "appControl", args });
    assert.strictEqual(replay.status, "denied");
    assert.strictEqual(replay.reason, "replay");
  });

  await check("unknown tool names can never be registered", async () => {
    const { authority } = buildStack();
    for (const toolName of ["runPowerShell", "shellExec", "cmdControl", "taskRunner"]) {
      const reg = authority.registerPendingCall({
        callId: "p3-bad-" + toolName,
        toolName,
        args: {},
        sessionId: SESSION,
      });
      assert.strictEqual(reg.ok, false, toolName + " must not register");
      assert.strictEqual(reg.reason, "unknownToolName");
    }
  });

  await check("without an injected controller the tools fail closed", async () => {
    const { authority } = buildStack({ withApp: false, withTask: false });
    for (const toolName of ["appControl", "taskControl"]) {
      const reg = authority.registerPendingCall({
        callId: "p3-missing-" + toolName,
        toolName,
        args: { action: "status" },
        sessionId: SESSION,
      });
      assert.strictEqual(reg.ok, false);
      assert.strictEqual(reg.reason, "unknownToolName");
    }
  });

  await check("the kill switch blocks app control execution", async () => {
    const { authority, killSwitch } = buildStack();
    killSwitch.release("test");
    const args = { action: "list" };
    const reg = authority.registerPendingCall({
      callId: "p3-kill-1",
      toolName: "appControl",
      args,
      sessionId: SESSION,
    });
    assert.strictEqual(reg.ok, true);

    killSwitch.engage("test");
    const denied = authority.handleExecuteTool({ ticket: reg.ticket, name: "appControl", args });
    assert.strictEqual(denied.status, "denied");
    assert.strictEqual(denied.reason, "killSwitchActive");

    const blockedRegistration = authority.registerPendingCall({
      callId: "p3-kill-2",
      toolName: "taskControl",
      args: { action: "status" },
      sessionId: SESSION,
    });
    assert.strictEqual(blockedRegistration.ok, false);
    assert.strictEqual(blockedRegistration.reason, "killSwitchActive");
    killSwitch.release("test");
  });

  await check("a multi-step task runs through the same authenticated path", async () => {
    const { authority, completions } = buildStack();

    const planArgs = { action: "plan", steps: [{ type: "launchApp", app: "notepad" }] };
    const planReg = authority.registerPendingCall({
      callId: "p3-task-plan",
      toolName: "taskControl",
      args: planArgs,
      sessionId: SESSION,
    });
    assert.strictEqual(planReg.ok, true, JSON.stringify(planReg));
    authority.handleExecuteTool({ ticket: planReg.ticket, name: "taskControl", args: planArgs });
    assert.ok(await waitFor(() => completions.length === 1));

    const planResult = completions[0].receipt.result;
    assert.strictEqual(planResult.ok, true, JSON.stringify(planResult));
    assert.strictEqual(planResult.action, "plan");
    assert.ok(/^[a-f0-9]{32}$/.test(planResult.planId));
    assert.strictEqual(planResult.stepCount, 1);
    assert.ok(!JSON.stringify(planResult).includes("approvalId"));

    const runArgs = { action: "run", planId: planResult.planId };
    const runReg = authority.registerPendingCall({
      callId: "p3-task-run",
      toolName: "taskControl",
      args: runArgs,
      sessionId: SESSION,
    });
    assert.strictEqual(runReg.ok, true);
    authority.handleExecuteTool({ ticket: runReg.ticket, name: "taskControl", args: runArgs });
    assert.ok(await waitFor(() => completions.length === 2), "the task completion must arrive");

    const receipt = completions[1].receipt;
    verifyReceipt(receipt);
    assert.strictEqual(receipt.executionStatus, "success");
    assert.strictEqual(receipt.result.ok, true, JSON.stringify(receipt.result));
    assert.strictEqual(receipt.result.state, "completed");
    assert.strictEqual(receipt.result.completed, 1);
    assert.strictEqual(receipt.result.steps[0].state, "done");
  });

  await check("a destructive task needs confirmation through the tool path", async () => {
    const { authority, completions } = buildStack();
    const launchArgs = { action: "launch", app: "notepad" };
    const launchReg = authority.registerPendingCall({
      callId: "p3-prep-launch",
      toolName: "appControl",
      args: launchArgs,
      sessionId: SESSION,
    });
    authority.handleExecuteTool({ ticket: launchReg.ticket, name: "appControl", args: launchArgs });
    assert.ok(await waitFor(() => completions.length === 1));

    const planArgs = { action: "plan", steps: [{ type: "closeApp", app: "notepad" }] };
    const planReg = authority.registerPendingCall({
      callId: "p3-prep-plan",
      toolName: "taskControl",
      args: planArgs,
      sessionId: SESSION,
    });
    authority.handleExecuteTool({ ticket: planReg.ticket, name: "taskControl", args: planArgs });
    assert.ok(await waitFor(() => completions.length === 2));

    const planned = completions[1].receipt.result;
    assert.strictEqual(planned.ok, true, JSON.stringify(planned));
    assert.strictEqual(planned.requiresConfirmation, true);

    const runArgs = { action: "run", planId: planned.planId };
    const runReg = authority.registerPendingCall({
      callId: "p3-prep-run",
      toolName: "taskControl",
      args: runArgs,
      sessionId: SESSION,
    });
    authority.handleExecuteTool({ ticket: runReg.ticket, name: "taskControl", args: runArgs });
    assert.ok(await waitFor(() => completions.length === 3));

    const refused = completions[2].receipt.result;
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.error, "confirmationRequired");
  });

  // -- static wiring --------------------------------------------------------

  await check("the authority registers both new executors", () => {
    const source = shell("electron/lib/handoffAuthority.cjs");
    assert.ok(source.includes('"appControl", "taskControl"'), "EXECUTOR_NAMES must include both");
    assert.ok(source.includes('executors.set("appControl"'));
    assert.ok(source.includes('executors.set("taskControl"'));
  });

  await check("the server declares the tools and keeps long tasks alive", () => {
    const source = shell("src/server/index.ts");
    assert.ok(/MAIN_EXECUTED_TOOLS[\s\S]{0,400}"appControl"/.test(source));
    assert.ok(/MAIN_EXECUTED_TOOLS[\s\S]{0,400}"taskControl"/.test(source));
    assert.ok(/\n    name: "appControl",/.test(source), "appControl declaration missing");
    assert.ok(/\n    name: "taskControl",/.test(source), "taskControl declaration missing");
    assert.ok(source.includes("LONG_RUNNING_TOOLS"), "multi-step tasks must outlive the 30s TTL");
    assert.ok(source.includes("confirmDestructive"), "destructive confirmation must be described");
    assert.ok(source.includes("closed:true"), "the prompt must forbid claiming an unverified close");
    assert.ok(source.includes("appNotInAllowlist"), "the prompt must teach the failure reasons");
    assert.ok(source.includes("taskControl"), "system instruction must mention taskControl");
  });

  await check("main process wires the controllers, IPC and task mirror", () => {
    const source = shell("electron/main.cjs");
    assert.ok(source.includes("createAppControl"));
    assert.ok(source.includes("createTaskRunner"));
    assert.ok(source.includes("app: appControl"));
    assert.ok(source.includes("task: taskControl"));
    assert.ok(source.includes('"myra:task:state:get"'));
    assert.ok(source.includes('"myra:task:state"'));
    assert.ok(source.includes("taskControl.cancel(\"killSwitch\")"));
  });

  await check("preload exposes a read-only task status bridge", () => {
    const source = shell("electron/preload.cjs");
    assert.ok(source.includes("taskStatus"));
    assert.ok(source.includes('invoke("myra:task:state:get")'));
    assert.ok(source.includes('on("myra:task:state"'));
    assert.ok(!source.includes("myra:task:start"), "the renderer must not be able to start tasks");
    assert.ok(!source.includes("myra:task:cancel"), "the renderer must not be able to cancel tasks");
  });

  await check("the UI renders the desktop task panel", () => {
    const source = shell("src/App.tsx");
    assert.ok(source.includes("desktop-task-panel"));
    assert.ok(source.includes("taskStatus"));
    assert.ok(source.includes("Desktop Task"));
    assert.ok(source.includes('case "appControl"'));
    assert.ok(source.includes('case "taskControl"'));
  });

  await check("app control never uses a shell and never spawns a command line", () => {
    const source = shell("electron/lib/appControl.cjs");
    assert.ok(!/shell:\s*true/.test(source), "shell:true must never appear");
    assert.ok(/shell:\s*false/.test(source), "spawn must pin shell:false");
    assert.ok(!/exec\(/.test(source), "no shell exec helper may be used");
    assert.ok(!/cmd\.exe/i.test(source), "cmd.exe must never be invoked");
    assert.ok(!/powershell.*-Command.*\$\{/.test(source), "scripts must not interpolate input into script text");
    assert.ok(source.includes("MYRA_WIN_IMAGES"), "window images must travel via env vars");

    const runner = shell("electron/lib/taskRunner.cjs");
    assert.ok(!/child_process/.test(runner), "the task runner must not spawn processes itself");
    assert.ok(!/exec\(/.test(runner));
  });

  await check("audit logging accepts app metadata and drops anything else", () => {
    assert.strictEqual(sanitizeField("app", "notepad").value, "notepad");
    assert.strictEqual(sanitizeField("action", "minimize").value, "minimize");
    assert.strictEqual(sanitizeField("step", 2).value, 2);
    assert.strictEqual(sanitizeField("filePath", "C:\\Users\\secret.txt").name, "__dropped_field__");
    assert.strictEqual(sanitizeField("token", "abc123").name, "__dropped_field__");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myra-phase3-audit-"));
    try {
      const logger = createAuditLogger(dir, "run-test");
      logger.audit("TASK_COMPLETED", { tool: "taskControl", app: "notepad", action: "launch", step: 0 });
      const line = logger.recent(1)[0];
      const parsed = JSON.parse(line);
      assert.strictEqual(parsed.event, "TASK_COMPLETED");
      assert.strictEqual(parsed.app, "notepad");
      assert.strictEqual(parsed.step, 0);
      assert.ok(!line.includes("C:\\\\"), "audit lines must not contain paths");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check("browser follow-up 'newTab' exists without changing other actions", () => {
    const source = shell("electron/lib/browserControl.cjs");
    assert.ok(source.includes('"newTab"'));
    assert.ok(source.includes("actionNewTab"));
    const declared = shell("src/server/index.ts");
    assert.ok(declared.includes('"newTab"'));
  });

  console.log("\n==================================================");
  if (failures.length > 0) {
    console.error("  " + failures.length + " PHASE 3 WIRING CHECK(S) FAILED");
    console.log("==================================================");
    process.exit(1);
  }
  console.log("  ALL " + passed + " PHASE 3 WIRING + TRUST-CHAIN CHECKS PASSED");
  console.log("==================================================");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
