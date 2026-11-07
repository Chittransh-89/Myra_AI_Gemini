"use strict";

/**
 * WhatsApp send regression suite.
 *
 * Part 1 — pure approval/normalization rules.
 * Part 2 — REAL Chromium (headless Chrome/Edge) + CDP against a WhatsApp-like
 *          page, exercising the exact code path the assistant uses:
 *            prepare() -> approval -> send() -> verification.
 *
 * The fixture reproduces the reported failure: the send control is disabled
 * until WhatsApp's own state sees the draft. The legacy single `.click()`
 * reported "clicked" while nothing was sent; the fixed path must actually send,
 * exactly once, and must not clear the input on failure.
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { WebSocket } = require("ws");

const {
  createWhatsAppBridge,
  normalizePhone,
  normalizeMessage,
  approvalDigest,
  verifyApproval,
} = require("../electron/lib/whatsappControl.cjs");

const FIXTURE = path.join(__dirname, "fixtures", "whatsapp-send-page.html");
const PHONE = "919876543210";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The exact expression the buggy send() used. Kept here so the regression can
// show WHY it failed: clicked:true, message never sent.
const LEGACY_SEND_JS = `(function () {
  var btn = document.querySelector("button[aria-label='Send']")
    || document.querySelector("div[aria-label='Send']")
    || document.querySelector("span[data-icon='send']");
  var el = btn && btn.closest ? (btn.closest("button") || btn) : btn;
  if (!el) return JSON.stringify({ clicked: false, reason: "sendButtonNotFound" });
  el.click();
  return JSON.stringify({ clicked: true });
})()`;

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function httpJson(port, pathname, method = "GET") {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      try { req.destroy(); } catch {}
      resolve(null);
    });
    req.end();
  });
}

async function waitUntil(fn, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) return true;
    await sleep(120);
  }
  throw new Error("timeout waiting for " + (label || "condition"));
}

/** Tiny CDP helper for the test page (navigation + evaluation). */
function connectPage(wsUrl, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, handshakeTimeout: 5000 });
    let nextId = 1;
    const pending = new Map();
    let closed = false;

    const session = {
      send(method, params = {}) {
        if (closed) return Promise.reject(new Error("cdpClosed"));
        const id = nextId++;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error("cdpTimeout:" + method));
          }, timeoutMs);
          pending.set(id, {
            resolve: (v) => { clearTimeout(timer); res(v); },
            reject: (e) => { clearTimeout(timer); rej(e); },
          });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      async evaluate(expression) {
        const res = await session.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        });
        if (res && res.exceptionDetails) throw new Error("pageException");
        return res && res.result ? res.result.value : null;
      },
      close() {
        closed = true;
        try { ws.close(); } catch {}
      },
    };

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id === undefined) return;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(String(msg.error.message || "cdpError")));
      else entry.resolve(msg.result);
    });
    ws.once("open", () => resolve(session));
    ws.once("error", () => reject(new Error("cdpError")));
  });
}

async function runTests() {
  console.log("==================================================");
  console.log("  WHATSAPP SEND REGRESSION SUITE                   ");
  console.log("==================================================");

  // -------------------------------------------------------------------------
  // Part 1 — pure rules
  // -------------------------------------------------------------------------
  console.log("\n[TEST 1] Approval binding and message/phone validation...");
  assert.deepStrictEqual(normalizePhone("+91 98765 43210"), { ok: true, digits: "919876543210" });
  assert.strictEqual(normalizePhone("123").error, "invalidPhone");
  assert.strictEqual(normalizeMessage("   Hello   from   Myra  ").message, "Hello from Myra");
  assert.strictEqual(normalizeMessage("   ").error, "emptyMessage");
  assert.strictEqual(normalizeMessage("x".repeat(1001)).error, "messageTooLong");

  const approvals = new Map();
  const id = crypto.randomBytes(16).toString("hex");
  approvals.set(id, {
    phone: PHONE,
    message: "Hello from Myra",
    digest: approvalDigest(PHONE, "Hello from Myra"),
    expiresAt: Date.now() + 60000,
    used: false,
  });
  assert.strictEqual(verifyApproval(approvals, { approvalId: id, phone: PHONE, message: "Hello from Myra" }).ok, true);
  assert.strictEqual(
    verifyApproval(approvals, { approvalId: id, phone: PHONE, message: "Different text" }).error,
    "approvalMismatch"
  );
  assert.strictEqual(
    verifyApproval(approvals, { approvalId: id, phone: "919000000000", message: "Hello from Myra" }).error,
    "approvalMismatch"
  );
  assert.strictEqual(verifyApproval(approvals, { approvalId: "nope", phone: PHONE, message: "x" }).error, "unknownApproval");
  approvals.get(id).used = true;
  assert.strictEqual(
    verifyApproval(approvals, { approvalId: id, phone: PHONE, message: "Hello from Myra" }).error,
    "approvalAlreadyUsed"
  );
  console.log("  ✔ TEST 1 PASSED: approvals bound to exact phone+text, single use");

  // -------------------------------------------------------------------------
  // Infrastructure: local page + real Chromium
  // -------------------------------------------------------------------------
  const browserPath = findBrowser();
  assert.ok(browserPath, "A Chromium browser (Chrome or Edge) is required for the integration tests");

  const html = fs.readFileSync(FIXTURE, "utf8");
  const httpPort = await freePort();
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve) => httpServer.listen(httpPort, "127.0.0.1", resolve));
  const fixtureUrl = `http://127.0.0.1:${httpPort}/chat`;

  const debugPort = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myra-wa-test-"));
  const browserProc = spawn(
    browserPath,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--remote-debugging-port=" + debugPort,
      "--user-data-dir=" + userDataDir,
      "--window-size=1000,800",
      fixtureUrl,
    ],
    { stdio: "ignore", windowsHide: true }
  );
  browserProc.on("error", () => {});

  let page = null;
  let targetId = null;

  const cleanup = async () => {
    try { if (page) page.close(); } catch {}
    try { browserProc.kill(); } catch {}
    await sleep(400);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    try { httpServer.close(); } catch {}
  };

  try {
    // Wait for the debugger endpoint and our page target.
    let targets = null;
    await waitUntil(async () => {
      targets = await httpJson(debugPort, "/json/list");
      return Array.isArray(targets) && targets.some((t) => t.type === "page" && String(t.url).startsWith(fixtureUrl));
    }, 20000, "Chromium debug target");

    const target = targets.find((t) => t.type === "page" && String(t.url).startsWith(fixtureUrl));
    targetId = target.id;
    page = await connectPage(target.webSocketDebuggerUrl);
    await page.send("Runtime.enable").catch(() => {});
    console.log("  Browser:", path.basename(browserPath), "| CDP port:", debugPort);

    // Close any extra tab so pickPage() can never target the wrong page.
    for (const t of targets) {
      if (t.type === "page" && t.id !== targetId) await httpJson(debugPort, "/json/close/" + t.id);
    }

    async function openCase(query) {
      await page.send("Page.navigate", { url: fixtureUrl + "?" + query });
      await waitUntil(async () => (await page.evaluate("window.__fixtureReady === true")) === true, 10000, "fixture ready");
    }

    const events = [];
    const logs = [];
    const browser = {
      status: () => ({ port: debugPort, browserName: "chrome-test" }),
      run: async (args) => ({ ok: true, action: args && args.action }),
      open: async () => ({ ok: true }),
    };
    const bridge = createWhatsAppBridge({
      browser,
      audit: (event, data) => events.push({ event, data }),
      log: (...args) => logs.push(args.join(" ")),
    });

    // -----------------------------------------------------------------------
    // Part 2 — legacy failure reproduction
    // -----------------------------------------------------------------------
    console.log("\n[TEST 2] Reproduce the legacy single-click failure...");
    await openCase("readyDelay=1500");
    await page.evaluate(
      "document.getElementById('composer').textContent = 'Hello from Myra'; document.getElementById('composer').focus();"
    );
    const legacyClick = JSON.parse(String(await page.evaluate(LEGACY_SEND_JS)));
    assert.strictEqual(legacyClick.clicked, true, "legacy probe reported a click");
    await sleep(1800); // enough time for the button to become enabled
    const legacySent = await page.evaluate("window.__sent");
    const legacyComposer = await page.evaluate("document.getElementById('composer').innerText");
    assert.strictEqual(legacySent, 0, "legacy synthetic click must NOT send while the control is disabled");
    assert.ok(String(legacyComposer).includes("Hello from Myra"), "text must still be in the input");
    console.log("  ✔ TEST 2 PASSED: clicked:true while nothing was sent — the reported bug");

    // -----------------------------------------------------------------------
    // Part 3 — Enter path, seeded identical message, exactly-once
    // -----------------------------------------------------------------------
    console.log("\n[TEST 3] prepare -> send via trusted Enter (with an older identical message present)...");
    await openCase("seed=1&seedText=Hello%20from%20Myra");
    const prep3 = await bridge.prepare({ phone: PHONE, message: "Hello from Myra" });
    assert.strictEqual(prep3.ok, true, "prepare must succeed: " + JSON.stringify(prep3));
    assert.strictEqual(prep3.sent, false, "prepare must never send");
    assert.strictEqual(await page.evaluate("window.__sent"), 0, "no message sent during prepare");
    assert.ok(
      String(await page.evaluate("document.getElementById('composer').innerText")).includes("Hello from Myra"),
      "prepare must leave the approved text in the composer"
    );

    const mismatch = await bridge.send({ approvalId: prep3.approvalId, phone: PHONE, message: "Hello from Myra!" });
    assert.strictEqual(mismatch.error, "approvalMismatch", "a different text must be rejected");
    assert.strictEqual(await page.evaluate("window.__sent"), 0, "rejected send must not act");

    const sent3 = await bridge.send({ approvalId: prep3.approvalId, phone: PHONE, message: "Hello from Myra" });
    assert.strictEqual(sent3.ok, true, "send must succeed: " + JSON.stringify(sent3));
    assert.strictEqual(sent3.sent, true);
    assert.strictEqual(sent3.verified, true);
    assert.strictEqual(sent3.method, "enter", "trusted Enter should be the primary path");
    assert.strictEqual(sent3.verification.occurrencesBefore, 1, "baseline must see the older identical message");
    assert.strictEqual(sent3.verification.occurrencesAfter, 2, "verification must count exactly one new message");
    assert.strictEqual(await page.evaluate("window.__sent"), 1, "exactly one message sent");
    assert.strictEqual(await page.evaluate("document.getElementById('composer').innerText"), "", "input cleared after send");

    const replay3 = await bridge.send({ approvalId: prep3.approvalId, phone: PHONE, message: "Hello from Myra" });
    assert.strictEqual(replay3.error, "approvalAlreadyUsed", "the approval must be single use");
    assert.strictEqual(await page.evaluate("window.__sent"), 1, "replay must not send a duplicate");
    console.log("  ✔ TEST 3 PASSED: sent once via Enter, verified against baseline, replay blocked");

    // -----------------------------------------------------------------------
    // Part 4 — Enter disabled, localized send label -> trusted button fallback
    // -----------------------------------------------------------------------
    console.log("\n[TEST 4] Enter-to-send OFF + Hindi label + trusted-click requirement...");
    await openCase("enter=0&label=hi&requireTrusted=1&readyDelay=400");
    const prep4 = await bridge.prepare({ phone: PHONE, message: "Fallback path works" });
    assert.strictEqual(prep4.ok, true, "prepare must succeed: " + JSON.stringify(prep4));
    const sent4 = await bridge.send({ approvalId: prep4.approvalId, phone: PHONE, message: "Fallback path works" });
    assert.strictEqual(sent4.ok, true, "send must succeed: " + JSON.stringify(sent4));
    assert.strictEqual(sent4.method, "sendButton", "must fall back to the enabled send control");
    assert.strictEqual(await page.evaluate("window.__sent"), 1, "exactly one message sent");
    assert.strictEqual(await page.evaluate("window.__lastMethod"), "button", "the real button handler ran");
    assert.strictEqual(await page.evaluate("document.getElementById('composer').innerText"), "", "input cleared after send");
    console.log("  ✔ TEST 4 PASSED: structural button discovery + trusted mouse click sent once");

    // -----------------------------------------------------------------------
    // Part 5 — dead control: meaningful error, input preserved, no duplicate
    // -----------------------------------------------------------------------
    console.log("\n[TEST 5] Unsent message must fail honestly and keep the draft...");
    await openCase("dead=1");
    const prep5 = await bridge.prepare({ phone: PHONE, message: "This cannot send" });
    assert.strictEqual(prep5.ok, true, "prepare may draft a message even if sending is blocked");
    const sent5 = await bridge.send({ approvalId: prep5.approvalId, phone: PHONE, message: "This cannot send" });
    assert.strictEqual(sent5.ok, false);
    assert.strictEqual(sent5.sent, false);
    assert.strictEqual(sent5.error, "sendNotConfirmed");
    assert.strictEqual(sent5.composerStillHasText, true, "a failed send must not clear the input");
    assert.strictEqual(await page.evaluate("window.__sent"), 0, "nothing was sent");
    assert.ok(
      String(await page.evaluate("document.getElementById('composer').innerText")).includes("This cannot send"),
      "the draft must survive a failed send"
    );
    const replay5 = await bridge.send({ approvalId: prep5.approvalId, phone: PHONE, message: "This cannot send" });
    assert.strictEqual(replay5.error, "approvalAlreadyUsed", "a failed attempt still consumes the approval");
    assert.strictEqual(await page.evaluate("window.__sent"), 0, "no duplicate attempt");
    console.log("  ✔ TEST 5 PASSED: explicit sendNotConfirmed, draft kept, single attempt");

    // -----------------------------------------------------------------------
    // Part 6 — audit trail reflects reality
    // -----------------------------------------------------------------------
    console.log("\n[TEST 6] Audit trail...");
    assert.ok(events.some((e) => e.event === "WHATSAPP_PREPARED"), "prepare must be audited");
    assert.ok(events.some((e) => e.event === "WHATSAPP_SENT"), "a verified send must be audited");
    assert.ok(events.some((e) => e.event === "WHATSAPP_SEND_UNVERIFIED"), "an unverified send must be audited");
    assert.ok(!logs.some((l) => l.includes("Hello from Myra")), "logs must not contain message text");
    console.log("  ✔ TEST 6 PASSED: honest audit events, no message content in logs");

    console.log("\n==================================================");
    console.log("  ALL WHATSAPP SEND TESTS PASSED                   ");
    console.log("==================================================");
  } finally {
    await cleanup();
  }
}

runTests().catch(async (err) => {
  console.error("\nTEST FAILED:", err && err.stack ? err.stack : err);
  process.exit(1);
});
