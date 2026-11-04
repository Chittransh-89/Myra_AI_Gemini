"use strict";

const crypto = require("crypto");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { createHandoffAuthority } = require("../electron/lib/handoffAuthority.cjs");
const { createProjectControl } = require("../electron/lib/projectControl.cjs");
const { createKillSwitch } = require("../electron/lib/killSwitch.cjs");
const iv = require("../electron/lib/ipcValidate.cjs");

async function runHandoffProjectTests() {
  console.log("==================================================");
  console.log("  HANDOFF AUTHORITY + PROJECT CONTROL TEST SUITE  ");
  console.log("==================================================");

  const receiptKey = crypto.randomBytes(32);
  const emittedCompletions = [];
  const notifications = [];

  const killSwitch = createKillSwitch();
  const pc = createProjectControl({ log: () => {} });

  const authority = createHandoffAuthority({
    audit: () => {},
    killSwitch,
    receiptKey,
    project: pc,
    emitCompletion: (frame) => {
      emittedCompletions.push(frame);
      return true;
    },
    notifyExecuting: (callId, sessionId) => {
      notifications.push({ callId, sessionId });
    },
  });

  // 1. Register projectControl detect call
  console.log("\n[TEST 1] Register projectControl detect call...");
  const sessionId = "session_test_0001";
  const reg1 = authority.registerPendingCall({
    callId: "call_proj_1",
    toolName: "projectControl",
    args: { action: "detect" },
    sessionId,
  });

  assert.strictEqual(reg1.ok, true, "Registration must succeed");
  assert.ok(typeof reg1.ticket === "string", "Ticket must be returned");
  console.log("  ✔ TEST 1 PASSED: Registered pending call and received ticket");

  // 2. Execute detect via authority
  console.log("\n[TEST 2] Execute projectControl detect through authority...");
  const res1 = authority.handleExecuteTool({
    ticket: reg1.ticket,
    name: "projectControl",
    args: { action: "detect" },
  });

  // Async executor returns { status: "accepted" }
  assert.strictEqual(res1.status, "accepted", "Async executor must return accepted");

  // Wait for async completion to emit
  await new Promise((r) => setTimeout(r, 600));

  assert.strictEqual(emittedCompletions.length, 1, "Must emit 1 completion");
  const comp1 = emittedCompletions[0].receipt;
  assert.strictEqual(comp1.toolName, "projectControl");
  assert.strictEqual(comp1.executionStatus, "success");
  assert.strictEqual(comp1.callId, "call_proj_1");
  assert.strictEqual(comp1.sessionId, sessionId);
  assert.ok(comp1.result.ok, "Result must have ok: true");
  assert.ok(comp1.result.root, "Result must have root");

  // Verify HMAC signature of completion
  const { sig, ...payload } = comp1;
  const canonical = iv.canonicalJsonOrNull(payload, 16 * 1024);
  const expectedSig = iv.hmacHex(receiptKey, iv.COMPLETION_DOMAIN, canonical);
  assert.strictEqual(sig, expectedSig, "Completion HMAC signature must verify");
  console.log("  ✔ TEST 2 PASSED: Completion minted and verified with HMAC");

  // 3. Ticket single-use / replay rejection
  console.log("\n[TEST 3] Replaying the same ticket must be rejected...");
  const replay = authority.handleExecuteTool({
    ticket: reg1.ticket,
    name: "projectControl",
    args: { action: "detect" },
  });
  assert.strictEqual(replay.status, "denied");
  assert.strictEqual(replay.reason, "replay");
  console.log("  ✔ TEST 3 PASSED: Replay attack rejected");

  // 4. Argument tampering rejection
  console.log("\n[TEST 4] Tampering with arguments must be rejected...");
  const reg2 = authority.registerPendingCall({
    callId: "call_proj_2",
    toolName: "projectControl",
    args: { action: "detect" },
    sessionId,
  });
  const tampered = authority.handleExecuteTool({
    ticket: reg2.ticket,
    name: "projectControl",
    args: { action: "detect", malicious: true },
  });
  assert.strictEqual(tampered.status, "denied");
  assert.strictEqual(tampered.reason, "argsTampered");
  console.log("  ✔ TEST 4 PASSED: Argument tampering blocked");

  // 5. Kill switch blocks execution
  console.log("\n[TEST 5] Kill switch blocks execution...");
  const reg3 = authority.registerPendingCall({
    callId: "call_proj_3",
    toolName: "projectControl",
    args: { action: "detect" },
    sessionId,
  });
  killSwitch.engage("test-emergency");
  const killed = authority.handleExecuteTool({
    ticket: reg3.ticket,
    name: "projectControl",
    args: { action: "detect" },
  });
  assert.strictEqual(killed.status, "denied");
  assert.strictEqual(killed.reason, "killSwitchActive");
  killSwitch.release("test-release");
  console.log("  ✔ TEST 5 PASSED: Kill switch stopped execution");

  console.log("\n==================================================");
  console.log("  ALL HANDOFF AUTHORITY PROJECT TESTS PASSED!    ");
  console.log("==================================================");
}

runHandoffProjectTests().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
