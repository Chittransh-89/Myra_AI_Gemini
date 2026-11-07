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
 * Why `send()` no longer uses element.click() alone:
 *   A CDP `Runtime.evaluate` click is NOT a user gesture, does not focus the
 *   composer, and returns `clicked: true` even when WhatsApp's React send control
 *   is still disabled (it is disabled until WhatsApp's own state sees the draft).
 *   The old result was a silent no-op: text sat in the input and the message was
 *   never sent. `send()` now (a) puts the approved text into the composer if the
 *   deep-link draft is missing, (b) focuses the composer with a real mouse event,
 *   (c) presses Enter through CDP `Input.dispatchKeyEvent` (trusted — honours the
 *   "Enter is send" setting), (d) falls back to a trusted mouse click on the
 *   right-most ENABLED footer button (structural, so localized labels work), and
 *   (e) only reports success when the message actually appears in the
 *   conversation, compared against a count taken before sending so an identical
 *   older message can never be mistaken for this send.
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
const COMPOSE_ENTER_TIMEOUT_MS = 2400; // wait for a click to place the caret
const COMPOSE_TYPE_VERIFY_MS = 3000; // wait for typed text to appear
const SEND_VERIFY_MS = 7500; // wait for proof the message left the composer
const SEND_BUTTON_WAIT_MS = 4000; // wait for the send control to become enabled
const SEND_POLL_MS = 250;
const POLL_MS = 600;
const CDP_CALL_TIMEOUT_MS = 9000;

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

/** Compare text the way the composer renders it (zero-widths, collapsed spaces). */
function normalizeComparable(text) {
  return String(text == null ? "" : text)
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Minimal CDP client (own socket, so browserControl stays untouched)
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
      try {
        req.destroy();
      } catch {}
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

/**
 * One CDP target connection that can issue MANY commands. The previous helper
 * opened a socket per expression and could only evaluate JavaScript, so it had no
 * way to send trusted keyboard/mouse input.
 */
function connectCdp(wsUrl, timeoutMs = CDP_CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl, { perMessageDeflate: false, handshakeTimeout: 5000 });
    } catch {
      return reject(new Error("cdpConnectFailed"));
    }

    let nextId = 1;
    let closed = false;
    const pending = new Map();

    const failAll = (reason) => {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
      }
      pending.clear();
    };

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
            timer,
            resolve: (value) => {
              clearTimeout(timer);
              res(value);
            },
            reject: (err) => {
              clearTimeout(timer);
              rej(err);
            },
          });
          try {
            ws.send(JSON.stringify({ id, method, params }));
          } catch (err) {
            clearTimeout(timer);
            pending.delete(id);
            rej(err);
          }
        });
      },

      /**
       * userGesture:true is what makes WhatsApp treat the evaluation as a real
       * user activation instead of an inert script action.
       */
      async evaluate(expression, extra = {}) {
        const res = await session.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
          ...extra,
        });
        if (res && res.exceptionDetails) throw new Error("pageException");
        return res && res.result ? res.result.value : null;
      },

      close() {
        closed = true;
        try {
          ws.close();
        } catch {}
        failAll("cdpClosed");
      },
    };

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id === undefined) return; // events are not needed
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(String(msg.error.message || "cdpError")));
      else entry.resolve(msg.result);
    });

    ws.once("open", () => resolve(session));
    ws.once("error", () => {
      closed = true;
      failAll("cdpError");
      reject(new Error("cdpError"));
    });
    ws.once("close", () => {
      closed = true;
      failAll("cdpClosed");
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

/** The composer: located structurally, never by a localized label. */
const COMPOSER_JS = `(function () {
  var el = document.querySelector("#main footer div[contenteditable='true'][role='textbox']")
    || document.querySelector("#main footer div[contenteditable='true']")
    || document.querySelector("footer div[contenteditable='true']");
  if (!el) return JSON.stringify({ found: false });
  var r = el.getBoundingClientRect();
  return JSON.stringify({
    found: true,
    visible: r.width > 0 && r.height > 0,
    text: el.innerText || "",
    focused: document.activeElement === el,
    rect: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  });
})()`;

/**
 * The send control: right-most ENABLED button in the footer. WhatsApp puts the
 * send affordance on the right; disabled/hidden controls are skipped so a click
 * can never land on a dead button. A localized "send" label or data-icon is used
 * only as a bonus signal, never as the only way to find it.
 */
const SEND_BUTTON_JS = `(function () {
  var footer = document.querySelector("#main footer") || document.querySelector("footer");
  if (!footer) return JSON.stringify({ found: false, reason: "noFooter" });
  var buttons = footer.querySelectorAll("button");
  var HINTS = /send|enviar|senden|envoyer|invia|versturen|verzenden|भेज|送信|보내|إرسال|gửi|kirim|sende/i;
  var best = null;
  for (var i = 0; i < buttons.length; i++) {
    var b = buttons[i];
    var r = b.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    var style = window.getComputedStyle(b);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
    if (b.disabled === true || b.getAttribute("aria-disabled") === "true") continue;
    var label = b.getAttribute("aria-label") || b.getAttribute("title") || "";
    var hinted = HINTS.test(label) || b.getAttribute("data-icon") === "send";
    var score = (hinted ? 1000000 : 0) + r.right;
    if (!best || score > best.score) {
      best = {
        score: score,
        label: label,
        rect: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      };
    }
  }
  if (!best) return JSON.stringify({ found: false, reason: "noEnabledSendButton" });
  return JSON.stringify({ found: true, rect: best.rect, label: best.label, hinted: best.score >= 1000000 });
})()`;

/**
 * Conversation evidence. Counts occurrences of the exact message in #main with
 * the footer/composer removed, so a draft can never be counted as a sent message.
 */
function conversationJs(message) {
  return `(function () {
  var want = ${JSON.stringify(message)};
  function norm(s) {
    return String(s == null ? "" : s).replace(/\\u200b/g, "").replace(/\\s+/g, " ").trim();
  }
  var scope = document.querySelector("#main") || document.body;
  var composer = (scope && scope.querySelector("footer div[contenteditable='true']"))
    || document.querySelector("footer div[contenteditable='true']");
  var composerText = composer ? norm(composer.innerText) : "";
  var clone = scope ? scope.cloneNode(true) : null;
  if (clone) {
    var clFooter = clone.querySelector("footer");
    if (clFooter && clFooter.parentNode) clFooter.parentNode.removeChild(clFooter);
  }
  var text = clone ? norm(clone.innerText) : "";
  var w = norm(want);
  var occurrences = 0;
  if (w) {
    var at = 0;
    while ((at = text.indexOf(w, at)) !== -1) { occurrences++; at += w.length; }
  }
  var rows = document.querySelectorAll("#main div.message-out, #main div[class*='message-out']");
  return JSON.stringify({
    occurrences: occurrences,
    composerText: composerText,
    composerEmpty: composerText.length === 0,
    outgoingRows: rows.length,
    conversationChars: text.length
  });
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
    // Used approvals are kept until they expire so a replay is reported as
    // approvalAlreadyUsed (an honest "already sent") instead of unknownApproval.
    for (const [id, a] of approvals) {
      if (a.expiresAt < now) approvals.delete(id);
    }
    while (approvals.size >= MAX_PENDING_APPROVALS) {
      const oldest = approvals.keys().next().value;
      if (oldest === undefined) break;
      approvals.delete(oldest);
    }
  }

  async function openTarget(matchUrl) {
    const info = browser.status() || {};
    const port = info.port;
    if (!port) throw new Error("browserNotRunning");
    const pages = await listPages(port);
    const target = pickPage(pages, matchUrl);
    if (!target) throw new Error("noPage");
    return connectCdp(target.webSocketDebuggerUrl);
  }

  /** One-shot evaluation (used for page state probes). */
  async function evaluate(expression, matchUrl) {
    const session = await openTarget(matchUrl);
    try {
      return await session.evaluate(expression);
    } finally {
      session.close();
    }
  }

  function parseJson(raw, fallback) {
    try {
      return JSON.parse(String(raw || ""));
    } catch {
      return fallback;
    }
  }

  async function readState() {
    try {
      return parseJson(await evaluate(READ_STATE_JS, "web.whatsapp.com"), {
        qr: false,
        chatList: false,
        compose: false,
        url: "",
      });
    } catch {
      return { qr: false, chatList: false, compose: false, url: "" };
    }
  }

  async function readStateIn(session) {
    return parseJson(await session.evaluate(READ_STATE_JS), {
      qr: false,
      chatList: false,
      compose: false,
      url: "",
    });
  }

  async function readComposer(session) {
    return parseJson(await session.evaluate(COMPOSER_JS), { found: false, visible: false, text: "" });
  }

  async function readConversation(session, message) {
    return parseJson(await session.evaluate(conversationJs(message)), {
      occurrences: 0,
      composerText: "",
      composerEmpty: false,
      outgoingRows: 0,
    });
  }

  /** A REAL mouse click at a viewport point (trusted input, real focus). */
  async function clickPoint(session, rect) {
    const x = Math.round(Number(rect && rect.x) || 0);
    const y = Math.round(Number(rect && rect.y) || 0);
    if (x <= 0 || y <= 0) throw new Error("badClickPoint");
    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }

  /** Trusted Enter keydown/keyup — exactly what a Windows user presses. */
  async function pressEnter(session) {
    const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...base,
      text: "\r",
      unmodifiedText: "\r",
    });
    await sleep(40);
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /**
   * Make sure the APPROVED text is what sits in the composer. If the deep-link
   * draft was lost, the text is typed with trusted CDP input. If the box holds
   * different text, we refuse rather than send something the user never approved.
   */
  async function ensureComposerText(session, message, { allowTyping }) {
    const want = normalizeComparable(message);
    let probe = await readComposer(session);
    if (!probe.found || !probe.visible) {
      return { ok: false, error: "composerNotFound", detail: "The chat input field is not on screen." };
    }

    const current = normalizeComparable(probe.text);
    if (current === want || current.indexOf(want) >= 0) {
      return { ok: true, typed: false, composer: probe };
    }

    if (current.length > 0) {
      return {
        ok: false,
        error: "composeContentMismatch",
        detail: "The chat input already contains different text, so Myra did not send it or overwrite it.",
        composer: probe,
      };
    }

    if (!allowTyping) return { ok: false, error: "composeEmpty", composer: probe };

    await clickPoint(session, probe.rect);
    await sleep(60);
    await session.send("Input.insertText", { text: message });

    const startedAt = Date.now();
    while (Date.now() - startedAt < COMPOSE_TYPE_VERIFY_MS) {
      probe = await readComposer(session);
      const text = normalizeComparable(probe.text);
      if (probe.found && text.indexOf(want) >= 0) {
        return { ok: true, typed: true, composer: probe };
      }
      await sleep(120);
    }

    return {
      ok: false,
      error: "composeTextFailed",
      detail: "Myra clicked the chat input but the message did not appear in it.",
      composer: probe,
    };
  }

  /** Wait until the current message text is present in the conversation. */
  async function waitForSend(session, message, baselineOccurrences, timeoutMs) {
    const startedAt = Date.now();
    let last = await readConversation(session, message);
    while (Date.now() - startedAt < timeoutMs) {
      if (last.occurrences > baselineOccurrences) {
        return { sent: true, ...last };
      }
      await sleep(SEND_POLL_MS);
      last = await readConversation(session, message);
    }
    return { sent: last.occurrences > baselineOccurrences, ...last };
  }

  async function waitForSendButton(session, timeoutMs) {
    const startedAt = Date.now();
    let probe = parseJson(await session.evaluate(SEND_BUTTON_JS), { found: false });
    while (!probe.found && Date.now() - startedAt < timeoutMs) {
      await sleep(SEND_POLL_MS);
      probe = parseJson(await session.evaluate(SEND_BUTTON_JS), { found: false });
    }
    return probe;
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

    let session = null;
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

      session = await openTarget("web.whatsapp.com");
      const after = await readStateIn(session);
      if (!after.compose) {
        return { ok: false, prepared: false, sent: false, error: "chatNotReady" };
      }

      // The deep link fills the box on most builds, but not always (slow load,
      // existing chat, WhatsApp dropping the draft). Verify it, and type the
      // approved text ourselves when it is missing — prepare must never claim a
      // draft that is not actually there.
      const placed = await ensureComposerText(session, message.message, { allowTyping: true });
      if (!placed.ok) {
        record("WHATSAPP_PREPARE_FAILED", { tool: "whatsappControl", reason: placed.error });
        return {
          ok: false,
          prepared: false,
          sent: false,
          error: placed.error,
          detail: placed.detail,
        };
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
        draftVerified: true,
        draftTypedByMyra: placed.typed === true,
        requiresConfirmation: true,
        expiresInSeconds: Math.round(APPROVAL_TTL_MS / 1000),
        detail:
          "Message is written in the chat but NOT sent. Ask the user to confirm, then call send with this approvalId, the same phone and the same message.",
      };
    } catch (err) {
      record("WHATSAPP_PREPARE_FAILED", { tool: "whatsappControl" });
      emit("WhatsApp prepare failed:", err && err.message);
      return { ok: false, prepared: false, sent: false, error: "whatsappPrepareFailed" };
    } finally {
      if (session) session.close();
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

    let session = null;
    try {
      session = await openTarget("web.whatsapp.com");
      const state = await readStateIn(session);
      if (state.qr) {
        record("WHATSAPP_SEND_DENIED", { tool: "whatsappControl", reason: "whatsappWebNotLinked" });
        return { ok: false, sent: false, error: "whatsappWebNotLinked" };
      }
      if (!state.compose) {
        record("WHATSAPP_SEND_DENIED", { tool: "whatsappControl", reason: "chatNotReady" });
        return { ok: false, sent: false, error: "chatNotReady" };
      }

      // The approved text must be in the box (typed if the draft was lost).
      const placed = await ensureComposerText(session, approval.message, { allowTyping: true });
      if (!placed.ok) {
        record("WHATSAPP_SEND_FAILED", { tool: "whatsappControl", reason: placed.error });
        return { ok: false, sent: false, error: placed.error, detail: placed.detail };
      }

      // Baseline BEFORE any action: an older identical message must never be
      // mistaken for this send (and must not block a legitimate repeat).
      const baseline = await readConversation(session, approval.message);

      // 1) Trusted focus + Enter (honours WhatsApp's "Enter is send").
      await clickPoint(session, placed.composer.rect);
      await sleep(COMPOSE_ENTER_TIMEOUT_MS);
      await pressEnter(session);
      let result = await waitForSend(session, approval.message, baseline.occurrences, SEND_VERIFY_MS);
      let method = result.sent ? "enter" : null;

      // 2) Trusted mouse click on the enabled send control. Only attempted when
      //    the Enter press produced no evidence, so a message is never sent twice.
      if (!result.sent) {
        const beforeButtonClick = await readConversation(session, approval.message);
        if (beforeButtonClick.occurrences > baseline.occurrences) {
          result = { sent: true, ...beforeButtonClick };
          method = "enter";
        } else {
          const button = await waitForSendButton(session, SEND_BUTTON_WAIT_MS);
          if (button.found) {
            await clickPoint(session, button.rect);
            result = await waitForSend(session, approval.message, baseline.occurrences, SEND_VERIFY_MS);
            if (result.sent) method = "sendButton";
          }
        }
      }

      if (!method) {
        // Last check: WhatsApp may have sent late while the button was clicked.
        const finalState = await readConversation(session, approval.message);
        if (finalState.occurrences > baseline.occurrences) {
          method = "observed";
          result = { sent: true, ...finalState };
        }
      }

      if (method) {
        record("WHATSAPP_SENT", { tool: "whatsappControl" });
        return {
          ok: true,
          sent: true,
          verified: true,
          method,
          phone: approval.phone,
          composeCleared: result.composerEmpty === true,
          verification: {
            occurrencesBefore: baseline.occurrences,
            occurrencesAfter: result.occurrences,
            outgoingRows: result.outgoingRows,
          },
        };
      }

      record("WHATSAPP_SEND_UNVERIFIED", { tool: "whatsappControl" });
      return {
        ok: false,
        sent: false,
        verified: false,
        error: "sendNotConfirmed",
        detail:
          "Myra pressed Enter and clicked the send control, but the message never appeared in the conversation. " +
          "The text is still in the chat input; nothing was sent twice.",
        composerStillHasText: result.composerEmpty === false,
        verification: {
          occurrencesBefore: baseline.occurrences,
          occurrencesAfter: result.occurrences,
          outgoingRows: result.outgoingRows,
        },
      };
    } catch (err) {
      record("WHATSAPP_SEND_FAILED", { tool: "whatsappControl", reason: "exception" });
      emit("WhatsApp send failed:", err && err.message);
      return { ok: false, sent: false, error: "whatsappSendFailed", detail: String((err && err.message) || "cdpError") };
    } finally {
      if (session) session.close();
    }
  }

  return { status, prepare, send, approvalsCount: () => approvals.size };
}

module.exports = {
  createWhatsAppBridge,
  normalizePhone,
  normalizeMessage,
  normalizeComparable,
  approvalDigest,
  verifyApproval,
  APPROVAL_TTL_MS,
};
