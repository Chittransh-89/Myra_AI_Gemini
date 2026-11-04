"use strict";

/**
 * Myra AI — WhatsApp control (Electron MAIN process).
 *
 * WHAT THIS IS: a "prepare -> user confirms -> send -> verify" bridge that drives
 * the user's OWN WhatsApp Web session inside Myra's dedicated browser profile.
 *
 * WHAT THIS IS NOT (deliberately):
 *  - It never reads WhatsApp's local databases, cookies, tokens or encryption
 *    keys. The session lives in Myra's own Chromium profile, like the user's own
 *    WhatsApp Web tab.
 *  - It never uses the unofficial "whatsapp-web.js"/Baileys reverse-engineered
 *    protocol, which can get an account banned.
 *  - It cannot send without a matching, unused, unexpired approval issued by
 *    `prepare()` for the EXACT same number and message text, and it reports only
 *    what it actually observed afterwards.
 *
 * WhatsApp's only officially supported programmatic API (Business Cloud API)
 * needs a separate business number and cannot send from a personal account. For
 * a personal account the supported surface is a click-to-chat deep link, which
 * opens a chat but can never confirm a send — so this module verifies the message
 * in the conversation and refuses to claim success when it cannot see it.
 */

const crypto = require("crypto");
const http = require("http");
const { WebSocket } = require("ws");

const WHATSAPP_WEB_URL = "https://web.whatsapp.com/";
const SEND_URL_BASE = "https://web.whatsapp.com/send?phone=";
const MAX_MESSAGE_LEN = 1000;
const MAX_PENDING_APPROVALS = 8;
const APPROVAL_TTL_MS = 2 * 60 * 1000; // 2 minutes to confirm
const LINK_CHECK_TIMEOUT_MS = 18000;
const SEND_SETTLE_MS = 2600;
const POLL_MS = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Validation (pure, unit-testable)
// ---------------------------------------------------------------------------

/** Digits-only international number, 8..15 digits (wa.me format). */
function normalizePhone(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return { ok: false, error: "missingPhone" };
  const digits = text.replace(/[^0-9]/g, "");
  if (digits.length < 8 || digits.length > 15) return { ok: false, error: "invalidPhone" };
  if (/^0+$/.test(digits)) return { ok: false, error: "invalidPhone" };
  return { ok: true, digits };
}

/** Trims, rejects control characters/empties, caps length. */
function normalizeMessage(raw) {
  const stripped = String(raw == null ? "" : raw).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  const message = stripped.replace(/[ \t]+/g, " ").trim();
  if (!message) return { ok: false, error: "emptyMessage" };
  if (message.length > MAX_MESSAGE_LEN) return { ok: false, error: "messageTooLong" };
  return { ok: true, message };
}

/** An approval is bound to the exact number AND the exact text. */
function approvalDigest(digits, message) {
  return crypto.createHash("sha256").update(digits + "\u0000" + message, "utf8").digest("hex");
}

/**
 * Verify a send request against pending approvals. Pure, so the binding rules can
 * be tested without a live WhatsApp session.
 * @returns {{ok: true, approval: object} | {ok: false, error: string}}
 */
function verifyApproval(approvals, request, nowMs = Date.now()) {
  const id = String((request && request.approvalId) || "").trim();
  if (!id) return { ok: false, error: "missingApprovalId" };

  const approval = approvals.get(id);
  if (!approval) return { ok: false, error: "unknownApproval" };
  if (approval.used) return { ok: false, error: "approvalAlreadyUsed" };
  if (approval.expiresAt < nowMs) {
    approvals.delete(id);
    return { ok: false, error: "approvalExpired" };
  }

  const phone = normalizePhone(request && request.phone);
  const message = normalizeMessage(request && request.message);
  if (!phone.ok) return { ok: false, error: phone.error };
  if (!message.ok) return { ok: false, error: message.error };

  if (approvalDigest(phone.digits, message.message) !== approval.digest) {
    return { ok: false, error: "approvalMismatch" };
  }

  return { ok: true, approval };
}

// ---------------------------------------------------------------------------
// Minimal CDP page probe (own socket, so browserControl stays untouched)
// ---------------------------------------------------------------------------

function httpGet(port, pathname) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      try { req.destroy(); } catch {}
      resolve(null);
    });
    req.end();
  });
}

async function listPages(port) {
  const body = await httpGet(port, "/json/list");
  if (!body) return [];
  try {
    return JSON.parse(body).filter((t) => t && t.type === "page" && t.webSocketDebuggerUrl);
  } catch {
    return [];
  }
}

/** Prefer Myra's own WhatsApp tab; otherwise fall back to the first page. */
function pickPage(pages, matchUrl) {
  if (!pages.length) return null;
  if (matchUrl) {
    const needle = String(matchUrl).toLowerCase();
    const hit = pages.find((p) => String(p.url || "").toLowerCase().indexOf(needle) >= 0);
    if (hit) return hit;
  }
  return pages[0];
}

function evalInTarget(wsUrl, expression, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    } catch (err) {
      return reject(err);
    }
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("cdpTimeout"));
    }, timeoutMs);
    ws.once("open", () => {
      try {
        ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
    ws.once("message", (data) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      try {
        const msg = JSON.parse(data.toString());
        if (msg && msg.result && msg.result.exceptionDetails) return reject(new Error("pageException"));
        resolve(msg && msg.result && msg.result.result ? msg.result.result.value : null);
      } catch (err) {
        reject(err);
      }
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// In-page probes (tolerant: WhatsApp Web changes its DOM regularly)
// ---------------------------------------------------------------------------

const READ_STATE_JS = `(function () {
  var text = document.body ? (document.body.innerText || "") : "";
  var flat = text.split(String.fromCharCode(10)).join(" ");
  var qr = document.querySelectorAll("canvas").length > 0
    || flat.indexOf("Scan to log in") >= 0
    || flat.indexOf("Link with phone number") >= 0;
  var chatList = !!(document.querySelector("#pane-side, [data-testid='chat-list'], div[aria-label='Chat list']"));
  var compose = !!(document.querySelector("#main footer div[contenteditable='true']")
    || document.querySelector("footer div[contenteditable='true']"));
  return JSON.stringify({
    url: location.href,
    qr: qr,
    chatList: chatList,
    compose: compose,
    snippet: flat.slice(0, 140)
  });
})()`;

const SEND_JS = `(function () {
  var btn = document.querySelector("button[aria-label='Send']")
    || document.querySelector("div[aria-label='Send']")
    || document.querySelector("span[data-icon='send']");
  var el = btn && btn.closest ? (btn.closest("button") || btn) : btn;
  if (!el) return JSON.stringify({ clicked: false, reason: "sendButtonNotFound" });
  el.click();
  return JSON.stringify({ clicked: true });
})()`;

/** Verify against the conversation itself rather than assuming the click worked. */
function verifyJs(message) {
  return `(function () {
    var want = ${JSON.stringify(message)};
    var scope = document.querySelector("#main") || document.body;
    var nodes = scope ? scope.querySelectorAll("span.selectable-text, div.copyable-text") : [];
    var hits = 0;
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].innerText || "").trim();
      if (t === want || t === want + " " || t === " " + want) hits++;
    }
    var plain = scope ? ((scope.innerText || "").indexOf(want) >= 0) : false;
    return JSON.stringify({ hits: hits, plain: plain });
  })()`;
}

const CHAT_URL_JS = "location.href";

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

function createWhatsAppBridge({ browser, audit, log } = {}) {
  const record = typeof audit === "function" ? audit : () => {};
  const emit = typeof log === "function" ? log : () => {};
  const approvals = new Map();

  // Fail closed: without the browser controller there are no WhatsApp actions.
  if (!browser || typeof browser.run !== "function" || typeof browser.status !== "function") {
    const unavailable = async () => ({ ok: false, sent: false, error: "browserUnavailable" });
    return { status: unavailable, prepare: unavailable, send: unavailable, approvalsCount: () => 0 };
  }

  function pruneApprovals() {
    const now = Date.now();
    for (const [id, a] of approvals) {
      if (a.used || a.expiresAt < now) approvals.delete(id);
    }
    while (approvals.size >= MAX_PENDING_APPROVALS) {
      const oldest = approvals.keys().next().value;
      if (oldest === undefined) break;
      approvals.delete(oldest);
    }
  }

  async function evaluate(expression, matchUrl) {
    const info = browser.status() || {};
    const port = info.port;
    if (!port) throw new Error("browserNotRunning");
    const pages = await listPages(port);
    const target = pickPage(pages, matchUrl);
    if (!target) throw new Error("noPage");
    return evalInTarget(target.webSocketDebuggerUrl, expression);
  }

  async function readState() {
    try {
      const raw = await evaluate(READ_STATE_JS, "web.whatsapp.com");
      return JSON.parse(String(raw || "{}"));
    } catch {
      return { qr: false, chatList: false, compose: false, url: "" };
    }
  }

  /** Bring the tab to WhatsApp Web and wait until we can tell linked vs QR. */
  async function ensureWhatsAppPage() {
    let current = "";
    try {
      current = String(await evaluate(CHAT_URL_JS, "web.whatsapp.com"));
    } catch {
      current = "";
    }
    const onWhatsApp = /^https:\/\/web\.whatsapp\.com\//i.test(current || "");
    if (!onWhatsApp) {
      await browser.run({ action: "open", url: WHATSAPP_WEB_URL });
      await sleep(2200);
    }

    const startedAt = Date.now();
    let state = await readState();
    while (Date.now() - startedAt < LINK_CHECK_TIMEOUT_MS) {
      if (state.qr) return { linked: false, state };
      if (state.chatList || state.compose) return { linked: true, state };
      await sleep(POLL_MS);
      state = await readState();
    }
    return { linked: false, state, timedOut: true };
  }

  async function status() {
    try {
      const { linked, state, timedOut } = await ensureWhatsAppPage();
      if (!linked) {
        return {
          ok: true,
          linked: false,
          needsQrLink: !!state.qr,
          error: timedOut ? "whatsappWebTimeout" : "whatsappWebNotLinked",
          detail:
            "WhatsApp Web is not linked in Myra's browser. Link it once by scanning the QR code at web.whatsapp.com with the phone, then sending works.",
        };
      }
      return { ok: true, linked: true, url: state.url || WHATSAPP_WEB_URL };
    } catch (err) {
      return { ok: false, linked: false, error: "whatsappStatusFailed" };
    }
  }

  async function prepare(args) {
    const phone = normalizePhone(args && args.phone);
    if (!phone.ok) return { ok: false, prepared: false, sent: false, error: phone.error };
    const message = normalizeMessage(args && args.message);
    if (!message.ok) return { ok: false, prepared: false, sent: false, error: message.error };

    try {
      const { linked, state } = await ensureWhatsAppPage();
      if (!linked) {
        return {
          ok: false,
          prepared: false,
          sent: false,
          error: state.qr ? "whatsappWebNotLinked" : "whatsappWebUnavailable",
          detail: "Link WhatsApp Web once by scanning the QR code in Myra's browser.",
        };
      }

      // Open the chat with the text already in the compose box. Nothing is sent.
      const url = SEND_URL_BASE + phone.digits + "&text=" + encodeURIComponent(message.message);
      await browser.run({ action: "open", url });
      await sleep(2600);

      const after = await readState();
      if (!after.compose) {
        return { ok: false, prepared: false, sent: false, error: "chatNotReady" };
      }

      pruneApprovals();
      const approvalId = crypto.randomBytes(16).toString("hex");
      approvals.set(approvalId, {
        phone: phone.digits,
        message: message.message,
        digest: approvalDigest(phone.digits, message.message),
        expiresAt: Date.now() + APPROVAL_TTL_MS,
        used: false,
      });

      record("WHATSAPP_PREPARED", { tool: "whatsappControl" });

      return {
        ok: true,
        prepared: true,
        sent: false,
        approvalId,
        phone: phone.digits,
        message: message.message,
        requiresConfirmation: true,
        expiresInSeconds: Math.round(APPROVAL_TTL_MS / 1000),
        detail:
          "Message is written in the chat but NOT sent. Ask the user to confirm, then call send with this approvalId, the same phone and the same message.",
      };
    } catch (err) {
      record("WHATSAPP_PREPARE_FAILED", { tool: "whatsappControl" });
      emit("WhatsApp prepare failed:", err && err.message);
      return { ok: false, prepared: false, sent: false, error: "whatsappPrepareFailed" };
    }
  }

  async function send(args) {
    pruneApprovals();
    const check = verifyApproval(approvals, args || {});
    if (!check.ok) {
      record("WHATSAPP_SEND_DENIED", { tool: "whatsappControl", reason: check.error });
      return { ok: false, sent: false, error: check.error };
    }
    const approval = check.approval;

    // Single use: consumed BEFORE acting, so a retry can never double-send.
    approval.used = true;

    try {
      const state = await readState();
      if (state.qr) {
        record("WHATSAPP_SEND_DENIED", { tool: "whatsappControl", reason: "whatsappWebNotLinked" });
        return { ok: false, sent: false, error: "whatsappWebNotLinked" };
      }
      if (!state.compose) {
        record("WHATSAPP_SEND_DENIED", { tool: "whatsappControl", reason: "chatNotReady" });
        return { ok: false, sent: false, error: "chatNotReady" };
      }

      const clickRaw = await evaluate(SEND_JS, "web.whatsapp.com");
      let clicked = false;
      try {
        clicked = JSON.parse(String(clickRaw || "{}")).clicked === true;
      } catch {
        clicked = false;
      }
      if (!clicked) {
        record("WHATSAPP_SEND_FAILED", { tool: "whatsappControl", reason: "sendButtonNotFound" });
        return { ok: false, sent: false, error: "sendButtonNotFound" };
      }

      await sleep(SEND_SETTLE_MS);

      let hits = 0;
      try {
        const parsed = JSON.parse(String((await evaluate(verifyJs(approval.message), "web.whatsapp.com")) || "{}"));
        hits = Number(parsed.hits) || 0;
        if (!hits && parsed.plain) hits = 1;
      } catch {
        hits = 0;
      }

      if (hits > 0) {
        record("WHATSAPP_SENT", { tool: "whatsappControl" });
        return { ok: true, sent: true, verified: true, phone: approval.phone };
      }

      record("WHATSAPP_SEND_UNVERIFIED", { tool: "whatsappControl" });
      return {
        ok: false,
        sent: false,
        verified: false,
        error: "sendNotVerified",
        detail: "Send was clicked but the message was not found in the conversation.",
      };
    } catch (err) {
      record("WHATSAPP_SEND_FAILED", { tool: "whatsappControl", reason: "exception" });
      emit("WhatsApp send failed:", err && err.message);
      return { ok: false, sent: false, error: "whatsappSendFailed" };
    }
  }

  return { status, prepare, send, approvalsCount: () => approvals.size };
}

module.exports = {
  createWhatsAppBridge,
  normalizePhone,
  normalizeMessage,
  approvalDigest,
  verifyApproval,
  APPROVAL_TTL_MS,
};
