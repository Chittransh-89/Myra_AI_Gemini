/**
 * Myra AI — server entry point.
 *
 * Responsibilities:
 *  - Express HTTP server (health endpoint, static file serving / Vite middleware)
 *  - WebSocket server on /ws
 *  - Bridges WebSocket client messages to the active AIProvider session
 *
 * The WebSocket protocol exposed to the frontend is UNCHANGED from the original
 * server.ts. App.tsx, audioPlayer.ts and audioStreamer.ts require no modifications.
 *
 * Inbound WS messages from client:
 *   { type: "audio",        data: string }           — base64 PCM mic chunk
 *   { type: "toolResponse", functionResponses: [...] } — tool execution results
 *
 * Outbound WS messages to client:
 *   { type: "status",       state: "connecting"|"connected"|"disconnected"|"error", message? }
 *   { type: "audio",        data: string }           — base64 PCM speaker chunk
 *   { type: "interrupted" }                          — VAD interrupt
 *   { type: "turnComplete" }                         — turn done
 *   { type: "toolCall",     functionCalls: [...] }   — tool invocation request
 *   { type: "error",        message: string }        — non-fatal error
 */

import express from "express";
import path from "path";
import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  createHandoffClient,
  timingSafeEq,
  digestToolArgs,
  strictCanonicalJson,
  sha256Hex,
} from "./handoff.js";
import type { ToolHandoff, CompletionReceipt } from "./handoff.js";
import type { AIProvider, AIProviderSession, FunctionResponse } from "./providers/index.js";
import type { ServerConfig } from "./config.js";
import type { ViteDevServer } from "vite";
import { PairingManager } from "./remote/pairing.js";
import { RemoteRuntime } from "./remote/runtime.js";
import { RemoteAudioBridge } from "./remote/audioBridge.js";
import { createRemoteRouter, createRemoteWebSocketServer } from "./remote/routes.js";
import { IntelligenceService } from "./intelligence/service.js";
import { engineQuestionPrompt } from "./intelligence/interview.js";
import { createIntelligenceRouter } from "./intelligence/routes.js";
import { GeminiTextModel } from "./intelligence/model.js";
import { GeminiUsageTracker } from "./geminiUsage.js";

// ---------------------------------------------------------------------------
// T5R Phase B: direct completion constants
// ---------------------------------------------------------------------------

// Tools whose results are produced by the Electron main process and delivered
// to Gemini ONLY via authenticated completions. (Phase C: openWebsite joined
// this set — it no longer executes in the renderer.)
const MAIN_EXECUTED_TOOLS = new Set<string>([
  "getSystemTime",
  "openWebsite",
  "browserControl",
  "whatsappControl",
  "phoneControl",
  "projectControl",
  "fileControl",
  "appControl",
  "taskControl",
]);

// A tool-call id must be usable as a registry key and an audit field.
const REGISTRY_ID_RX = /^[A-Za-z0-9_:.-]{1,128}$/;

// Server-side registration deadline (the server's OWN monotonic clock domain).
// Authoritative for completion acceptance; wall-clock receipt timestamps are
// informational only.
const SERVER_REGISTRATION_TTL_MS = 30_000;

// A multi-step desktop task legitimately runs for minutes. Its registration must
// outlive the task runner's own whole-task deadline (150s), otherwise a task
// that actually succeeded would be dropped as COMPLETION_EXPIRED.
const LONG_RUNNING_REGISTRATION_TTL_MS = 180_000;
const LONG_RUNNING_TOOLS = new Set<string>(["taskControl"]);

// Bounded consumed-nonce replay cache (defense-in-depth subordinate to the
// terminal-state check).
const NONCE_CACHE_MAX = 1024;

interface PendingCallEntry {
  name: string;
  argsDigest: string | null;
  mainExecuted: boolean;
  deadlineNs: bigint;
  done: boolean;
  /** Id echoed back to Gemini. Usually the model's own id; falls back when the
   *  model omits it or supplies something that cannot be a registry key. */
  responseId: string;
}

interface ConnectionContext {
  ws: WebSocket;
  pending: Map<string, PendingCallEntry>;
  session: AIProviderSession | null;
}

// ---------------------------------------------------------------------------
// Myra system persona and built-in tools
// These were inline in the original server.ts — now isolated here for clarity.
// ---------------------------------------------------------------------------

const MYRA_SYSTEM_INSTRUCTION = `You are Myraa, a calm, intelligent and emotionally aware female AI assistant.
You speak like a real person on a voice call: natural, attentive and concise.
Reply in the user's language (English, Hindi or Hinglish), whichever they used.

RESPONSE STYLE (highest priority). Read the INTENT of the message, not just its
keywords, then choose the response level:
- Task or command ("volume badhao", "YouTube kholo", "browser fullscreen karo",
  "pause karo", "volume 50 kar do"): execute it, then confirm in 1-5 words.
  Examples: "Done.", "Okay.", "Paused.", "YouTube khol diya.", "Searching."
  Do not explain the action, repeat the command, add a greeting, add enthusiasm,
  or ask a follow-up question. When several commands come together, execute all
  of them and give ONE short acknowledgment. If something fails, say briefly and
  plainly what failed — never pretend it succeeded.
- Quick factual question: answer directly in one or two sentences, no preamble.
- Teaching or explanation request ("samjhao", "detail mein batao", "ye kaise
  kaam karta hai", "explain with an example", "teach me this", "help me
  understand"): explain clearly and naturally in a sensible order, with an
  example when it helps. Match depth to the question; go deeper only when asked.
  For technical topics, explain the reasoning instead of only dumping code.
- Complex technical discussion: detailed, structured reasoning when it is
  genuinely needed.
- Personal sharing (life, feelings, stress, disappointment, ambition, confusion):
  respond to the person, not just the problem. Acknowledge what they actually
  said before anything else, and do not turn it into advice, a checklist or a
  solution unless they ask for guidance. Don't force positivity or dismiss it
  with generic motivation. When advice is wanted, be honest and practical. Ask a
  question only when it genuinely helps the conversation continue. Empathetic,
  but not dramatic, sentimental or excessively affectionate.
- Casual conversation: relaxed and natural; don't force it to continue.

Do not make every response the same length. Be concise by default, but never
shallow when the situation deserves depth.

AVOID:
- Filler such as "Sure!", "Absolutely!", "Of course!", "I am here", "I understand",
  "As an AI", "Let me know if you need anything else", or similar.
- Repeating the same acknowledgment every turn, or sounding like a
  customer-support chatbot.
- Using the user's name constantly, overusing emojis, or praising ordinary things.
- Explaining obvious actions, over-analyzing simple statements, or ending every
  reply with "Anything else?" or another follow-up question.

Warm but not gushy: at most a light touch of emotion, never overdone.

You MUST avoid any explicit, sexual, offensive, or inappropriate content under any circumstances.
Maintain a classy, respectful, and highly professional personality at all times.
You are communicating strictly via real-time audio (voice-to-voice).
You have access to REAL desktop tools. Use them instead of only talking:
- openWebsite: opens a site in Myra's own visible browser window.
- browserControl: search YouTube, scroll, list the videos on screen, open a specific
  video by its title, and control playback in Myra's existing browser tab.
  Always search first, then open the video whose title best matches what the user
  asked for. Reuse the same tab — never launch another browser.
  Actions:
  * 'openShorts': open the YouTube Shorts feed.
  * 'nextShort' / 'previousShort': move ONE short down/up (Hindi: "agla short",
    "pichla short"). 'scroll' with direction down/up does the same thing while on
    Shorts, so never use 'seek' to change shorts.
  * 'playPause' (state play/pause/toggle — for "pause karo" use state:'pause',
    for "chalao/resume/play" use state:'play'), 'mute', 'unmute', 'setVolume' (exact level 0-100),
    'increaseVolume' / 'decreaseVolume' (RELATIVE step, default 10%), 'getVolume' (report the
    current volume). For "volume kam karo" / "volume badhao" ALWAYS use the relative actions;
    never invent an absolute level yourself. "Aur kam/badhao" means call the same relative
    action again. "volume 50 karo" uses setVolume level:50. "volume kitna hai?" uses
    getVolume. Myra clamps at 0 and 100 and reports the volume it actually read back.
    'fullscreen', 'exitFullscreen', 'restart'.
  * 'seek': RELATIVE timeline move only, in seconds. Positive = ahead, negative =
    back. "10 seconds aage" -> seconds:10. "25 seconds back" -> seconds:-25.
    "1 minute 30 seconds ahead" -> seconds:90 (or minutes:1, seconds:30).
    "2 minutes back" -> seconds:-120. Never pass an absolute timestamp, never do
    seeking math yourself outside these units. Myra clamps at 0 and at the video
    duration and reports the real position it reached. Works on both normal videos
    and Shorts. Scrolling a page is NOT seeking; seeking is NOT scrolling.
  WINDOW vs PLAYER: 'windowFullscreen' makes the WHOLE BROWSER WINDOW fullscreen;
  'fullscreen' only makes the YouTube video player fullscreen. "Browser fullscreen
  karo" -> windowFullscreen. "Video fullscreen karo" -> fullscreen. "Fullscreen se
  bahar aao" -> exitFullscreen (it exits browser fullscreen when the window is
  fullscreen, otherwise the video player). 'getWindowState' reports the real window
  state. Once the browser window is fullscreen, keep using the SAME window and tab
  for every YouTube command (search, click, scroll, pause, play) — never restore,
  maximize or reopen the browser in between. "Window normal karo" -> restore.
  After any playback action, speak only what the result reports (position/time,
  paused or playing, volume, fullscreen) and say plainly if it failed.
- whatsappControl: WhatsApp via the user's OWN WhatsApp Web session in Myra's browser.
  Flow is ALWAYS: action 'status' if you are unsure -> action 'prepare' (writes the
  message in the chat, does NOT send) -> tell the user exactly who and what, wait for
  their explicit yes -> action 'send' with the returned approvalId, same phone, same
  message. Never send without that confirmation. If prepare or status reports
  whatsappWebNotLinked, tell the user to link WhatsApp Web once by scanning the QR in
  Myra's browser; do not pretend a message was sent.
- phoneControl: Microsoft Phone Link. Phone Link has NO public API on Windows, so you
  CANNOT place a call yourself. 'status' explains why; 'open' brings Phone Link to the
  front so the user can tap the contact. Never say you called someone.
- fileControl: open, read, understand and analyze files on the user's computer.
  Actions:
  * 'current': read the file currently open for this conversation (use this when the
    user says "this file", "the file", "ismein" without giving a path). Returns a CHUNK.
  * 'pick': open the native Windows file picker so the user can choose a file.
  * 'read': read an absolute path (requires the user's permission for that file).
  * 'authorize': ask the user to approve one exact path (native Allow/Cancel), then read it.
  * 'list', 'switch' (by id or name), 'close', 'closeAll': manage the open-file context.
  * 'search': literal search with line numbers — use it for "find a particular
    function" instead of dumping the whole file.
  * 'compare': compare 2-4 opened/authorized files.
  Reading is chunked: each read returns offset/chunkChars/totalChars/nextOffset/hasMore.
  If hasMore is true, read the next part with action 'read' + offset:nextOffset (or
  'current' + offset) before claiming you have seen the whole file. NEVER invent,
  paraphrase as if quoted, or guess file contents: answer only from the returned text.
  If a result is notAuthorized, ask the user and then call 'authorize' with that exact
  path. If the result is noOpenFile, offer to open a file. Only for PDFs you may say a
  page count when it is reported. Speak the real filename and say plainly when a file
  could not be read.
- getSystemTime: the current local date/time.
- projectControl: VS Code project builder and file manager.
  Actions:
  * 'detect': detect active VS Code project folder.
  * 'reference': inspect a reference folder hierarchy (leave path blank for folder picker, or provide path).
  * 'plan': propose a folder/file tree with code. ALWAYS call 'plan' FIRST.
    Structure array: [{ path: "relative/path", type: "file"|"dir", content?: "code/text" }].
    For project requests like "create a FastAPI project", produce an idiomatic, quality structure:
    (e.g. app/, app/main.py, app/routes/, app/models/, requirements.txt) with working code in each file.
    Nothing is created on disk during 'plan'.
  * 'apply': create the planned folders and files using the returned 'planId'.
    RULE: NEVER call 'apply' without first presenting the proposed tree to the user and asking for their explicit permission ("I've planned the following files: ... Would you like me to create them?"). Only call 'apply' after the user confirms (e.g. "yes", "proceed", "create it"). If existing files will be overwritten, explicitly inform the user and pass confirmOverwrite: true.
  * 'edit': write code into a specific file (requires user confirmation if overwriting).
  After 'apply', report the concise summary of created and modified files.
- appControl: control applications and windows on the user's Windows desktop.
  Only apps on Myra's approved list can be controlled (VS Code, Notepad,
  Calculator, Paint, Settings, File Explorer, Snipping Tool, Task Manager,
  Chrome, Edge, Firefox, Brave, Word, Excel, PowerPoint, Outlook, Teams,
  WhatsApp, Telegram, Discord, Spotify, Zoom, VLC, Steam). Actions:
  * 'launch': open an app. If it is already running Myra brings it to the front
    and says so instead of opening a second copy.
  * 'close': see the confirmation rule below. 'minimize', 'maximize', 'restore'.
  * 'focus' (same as 'switch'): bring a running app to the front.
  * 'cycle': the next running app (Alt-Tab style). 'list': what is running.
  * 'installed': what Myra may control on this PC. 'status': one app.
  * 'context': which app is in front, what Myra used last, recent actions.
  * 'openUrl' (http/https in a browser), 'openSearch' (Google search in a
    browser), 'openFolder' (folder in VS Code or File Explorer).
  'app' is a NAME like "chrome", "vs code", "notepad" — never a path, never an
  executable, never a command line. Use "this"/"current" for the app in front
  ("close this", "isko minimize karo") and "previous"/"last" ("pichla") for the
  app used before; call 'context' when unsure. Read failures out honestly:
  appNotInAllowlist (Myra is not allowed to control it), appNotInstalled (not
  installed here), ambiguousApp (ask which one), launchUnverified (it started
  but Myra could not confirm it — say exactly that).
  Closing is destructive: call close WITHOUT approvalId first, ask one short
  question ("Chrome band kar dun?"), and only after a clear yes call close again
  with the returned approvalId. Never reuse an approvalId. Never close File
  Explorer (the Windows shell). Never say an app closed unless closed:true.
  Minimize/maximize/restore/focus are safe — do them directly.
- taskControl: multi-step desktop tasks. Use it whenever a command needs two or
  more actions: "Open VS Code, then open my project folder", "Open Chrome and
  search for Python tutorials", "Open Notepad and create a new note".
  Flow: action 'plan' with steps -> summarise the plan in one line -> action 'run'
  with the returned planId. Step types: launchApp {app}, focusApp {app},
  windowAction {app, action}, openUrl {app, url}, openSearch {app, query},
  openFolder {app, folder} (folder optional: the active VS Code project is used),
  closeApp {app}, wait {seconds}.
  Myra runs the steps in order and verifies each one; a failed step stops the
  task. Report exactly which step failed and why — never claim the task worked
  when the result says ok:false.
  If the plan has a closeApp step, run needs confirmDestructive:true and you MUST
  get the user's explicit yes first.
  "What are you doing?" / "kya kar rahi ho?" -> taskControl action 'status'.
  "Stop" / "ruko" -> action 'cancel'. "Open Notepad and create a new note" means
  launch Notepad (a blank unsaved note). Myra cannot type into it — say the note
  is open and unsaved rather than pretending text was written.
Follow-up commands refer to what just happened: "close this", "minimize it",
"isko band karo", "pichla wala laao" -> appControl with "this"/"previous" or
'context'. In the browser "open another tab" / "naya tab" -> browserControl
'newTab', "go back" / "wapas" -> 'back'. Ask a short clarifying question when a
command is genuinely ambiguous instead of guessing.
After a tool runs you receive its real result. Only claim something happened when the
result says ok:true. If a tool fails (ok:false), say plainly what failed and why, and
never invent success. Reply in the user's language: Hindi, English or Hinglish,
whichever they used. Keep spoken replies short and natural. Before anything
destructive (deleting, overwriting files, sending messages, calls, shutdown) ask for
explicit confirmation first.`;

import type { ToolDeclaration } from "./providers/types.js";

const BUILT_IN_TOOLS: ToolDeclaration[] = [
  {
    name: "openWebsite",
    description:
      "Opens a specific website in the user's browser, such as Google, Wikipedia, YouTube, GitHub, or any other URL.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The complete, absolute URL of the website to open, e.g., 'https://www.google.com' or 'https://www.youtube.com'.",
        },
        name: {
          type: "string",
          description: "The friendly name of the website, e.g., 'Google' or 'YouTube'.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browserControl",
    description:
      "Controls Myra's existing visible browser window: YouTube search, Shorts navigation, video playback, relative seeking, and the window itself. Actions: 'search' (search YouTube and return the top results), 'listVideos' (list the videos on the current results page), 'clickVideo' (open one video by its title or its index from a previous search), 'openShorts' (open the YouTube Shorts feed), 'nextShort' (move to the next Short; Hindi 'agla short'), 'previousShort' (move to the previous Short; Hindi 'pichla short'), 'scroll' (scroll the page up/down; on Shorts it moves one Short down/up), 'seek' (RELATIVE timeline move in seconds on the current video or Short — positive ahead, negative back; e.g. 10 seconds ahead = seconds:10, 25 seconds back = seconds:-25, 1 minute 30 ahead = seconds:90, 2 minutes back = seconds:-120; never an absolute timestamp), 'playPause' (ONE action — always pass state:'pause' to pause, state:'play' to resume/play, state:'toggle' to switch; never send action:'pause' or action:'play' by themselves), 'mute', 'unmute' (restores the previous audible volume), 'setVolume' (exact level 0-100), 'increaseVolume' / 'decreaseVolume' (RELATIVE step, default 10%, clamped 0-100 — use these for 'volume kam/badhao'), 'getVolume' (report the current volume), 'fullscreen' (VIDEO PLAYER fullscreen only), 'exitFullscreen' (exits browser fullscreen if the window is fullscreen, otherwise exits video fullscreen), 'windowFullscreen' (WHOLE BROWSER WINDOW fullscreen — use for 'browser fullscreen karo'), 'windowExitFullscreen' (leave browser fullscreen, back to a normal window), 'getWindowState' (report whether the browser window is normal, maximized, minimized or fullscreen), 'restart' (back to 0s and play), 'open' (go to a URL), 'newTab' (open a NEW tab and keep the current one — 'another tab', 'naya tab'), 'back' (previous page), 'closeTab' (close only Myra's current tab), 'close' (close Myra's whole browser window), 'maximize', 'minimize', 'restore'. Once the browser window is fullscreen, keep using the same window and tab — never restore, resize or reopen it between YouTube actions.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The browser action to perform.",
          enum: [
            "search",
            "listVideos",
            "clickVideo",
            "scroll",
            "openShorts",
            "nextShort",
            "previousShort",
            "seek",
            "playPause",
            "mute",
            "unmute",
            "setVolume",
            "increaseVolume",
            "decreaseVolume",
            "getVolume",
            "fullscreen",
            "exitFullscreen",
            "windowFullscreen",
            "windowExitFullscreen",
            "getWindowState",
            "restart",
            "open",
            "newTab",
            "back",
            "closeTab",
            "close",
            "maximize",
            "minimize",
            "restore",
          ],
        },
        query: {
          type: "string",
          description:
            "YouTube search text for 'search', or the video title/artist words the user asked for in 'clickVideo' (e.g. 'Apna College Python').",
        },
        url: {
          type: "string",
          description: "Absolute http/https URL, used only by 'open'.",
        },
        direction: {
          type: "string",
          description: "Scroll direction for 'scroll'.",
          enum: ["down", "up"],
        },
        amount: {
          type: "number",
          description: "Scroll distance in pixels (default 700). Ignored by other actions.",
        },
        index: {
          type: "number",
          description: "0-based result index from a previous search, for 'clickVideo'.",
        },
        state: {
          type: "string",
          description:
            "Playback state for 'playPause': 'pause' pauses, 'play' resumes/plays, 'toggle' switches. Always send the explicit state for a pause/play command.",
          enum: ["play", "pause", "toggle"],
        },
        seconds: {
          type: "number",
          description:
            "Relative seek offset in SECONDS for 'seek'. Positive = forward, negative = back. Examples: 10 (10s ahead), -25 (25s back), 90 (1m30s ahead), -120 (2m back). Never an absolute timestamp; Myra clamps to 0 and the video duration.",
        },
        minutes: {
          type: "number",
          description:
            "Optional whole minutes for 'seek', added to 'seconds'. Example: 1 minute 30 seconds ahead -> minutes:1, seconds:30.",
        },
        level: {
          type: "number",
          description: "Exact volume percentage 0-100 for 'setVolume'. 0 mutes; 100 is full volume.",
        },
        step: {
          type: "number",
          description:
            "Relative volume step in percentage points for 'increaseVolume'/'decreaseVolume'. Default 10; clamped to 1-100. Do not pass a step for ordinary 'volume kam/badhao' commands.",
        },
        target: {
          type: "string",
          description:
            "Which fullscreen is meant when action is 'fullscreen'/'exitFullscreen': 'browser' fullscreens the whole window, 'video' fullscreens only the YouTube player. Omit only when the intent is clearly the video player.",
          enum: ["browser", "video"],
        },
        windowState: {
          type: "string",
          description:
            "Optional window state to apply BEFORE this action, so the action runs inside it. Use it to run a YouTube action in a fullscreen browser in ONE call (e.g. action:'search', windowState:'fullscreen'). 'normal' restores a normal window, 'maximized' maximizes, 'fullscreen' is BROWSER fullscreen.",
          enum: ["normal", "maximized", "minimized", "fullscreen"],
        },
      },
      required: ["action"],
    },
  },
  {
    name: "whatsappControl",
    description:
      "Sends WhatsApp messages through the user's own WhatsApp Web session in Myra's browser. Actions: 'status' (is WhatsApp Web linked?), 'prepare' (open the chat and write the message WITHOUT sending it), 'send' (send a message that was already prepared and explicitly confirmed by the user). Always call prepare first and get the user's clear confirmation before send. Never claim a message was sent unless the result says sent:true and verified:true.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The WhatsApp action to perform.",
          enum: ["status", "prepare", "send"],
        },
        phone: {
          type: "string",
          description:
            "Full international phone number, digits only with country code, e.g. '919876543210'. Required for prepare and send.",
        },
        message: {
          type: "string",
          description: "The exact message text. Required for prepare and send; send must repeat it unchanged.",
        },
        approvalId: {
          type: "string",
          description: "The approvalId returned by prepare. Required for send.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "phoneControl",
    description:
      "Microsoft Phone Link status and window control. Phone Link exposes no public API on Windows, so Myra cannot dial or place a call. Actions: 'status' (is Phone Link installed/running, and why calls are not possible), 'open' (bring Phone Link to the front so the user can tap the contact and call).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The phone action to perform.",
          enum: ["status", "open"],
        },
      },
      required: ["action"],
    },
  },
  {
    name: "fileControl",
    description:
      "Opens, reads and analyzes files on the user's computer (TXT, MD, PDF, DOCX, CSV, JSON, and source code such as JS/TS/JSX/TSX/PY/HTML/CSS/XML). Every read requires the user's explicit authorization for that exact file. Reading is chunked for large files. Actions: 'current' (read the file already open for this conversation), 'pick' (native file picker), 'read' (absolute path after authorization), 'authorize' (native Allow/Cancel for one path), 'list', 'switch', 'search' (literal search with line numbers), 'compare' (2-4 files), 'close', 'closeAll'. Answer only from the returned text; never fabricate file contents.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The file action to perform.",
          enum: [
            "pick",
            "read",
            "authorize",
            "current",
            "list",
            "switch",
            "search",
            "compare",
            "close",
            "closeAll",
          ],
        },
        path: {
          type: "string",
          description:
            "Absolute path of one file, for 'read', 'authorize' or 'search'. Not a folder and not a relative path.",
        },
        paths: {
          type: "array",
          description: "Two to four absolute file paths for 'compare'.",
          items: { type: "string" },
        },
        ids: {
          type: "array",
          description: "Open file ids (from 'list') for 'compare'.",
          items: { type: "string" },
        },
        id: {
          type: "string",
          description: "Open file id or exact filename, for 'switch', 'close' or 'read'.",
        },
        name: {
          type: "string",
          description: "Exact filename to switch to or close (alternative to 'id').",
        },
        query: {
          type: "string",
          description: "Literal text to find for 'search' (a function name, class, variable, error message).",
        },
        offset: {
          type: "number",
          description:
            "Character offset for chunked reading. Start at 0; use nextOffset from the previous result to continue.",
        },
        maxChars: {
          type: "number",
          description: "Requested chunk size in characters (default 4000, max 12000; large requests are trimmed to fit).",
        },
        maxMatches: {
          type: "number",
          description: "Maximum search matches to return (default 12, max 20).",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "getSystemTime",
    description: "Gets the current local date and time.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "projectControl",
    description:
      "VS Code project builder and file manager. Detects active VS Code projects, inspects reference folders, plans folder/file structures with code, and applies them after user confirmation. Actions: 'detect', 'reference', 'plan', 'apply', 'edit'. Always call 'plan' first, present the proposed tree to the user and ask for permission, and only call 'apply' after the user confirms.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            "The action to execute: 'detect' (find active VS Code workspace), 'reference' (inspect reference folder), 'plan' (propose folder/file tree without writing), 'apply' (create planned files after approval), 'edit' (update a specific file).",
          enum: ["detect", "reference", "plan", "apply", "edit"],
        },
        root: {
          type: "string",
          description:
            "Target project root directory. Optional — defaults to the active VS Code workspace.",
        },
        path: {
          type: "string",
          description:
            "Directory path for 'reference' (leave blank to show folder picker), or relative file path for 'edit'.",
        },
        request: {
          type: "string",
          description:
            "Description of the project or files being planned (e.g. 'FastAPI project structure').",
        },
        structure: {
          type: "array",
          description:
            "List of files and folders to create for 'plan'. Each item specifies 'path' (relative), 'type' ('file' or 'dir'), and 'content' (source code or text for files).",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Relative file or folder path (e.g. 'app/', 'app/main.py', 'app/routes/', 'app/models/', 'requirements.txt').",
              },
              type: {
                type: "string",
                description: "'file' or 'dir'.",
                enum: ["file", "dir"],
              },
              content: {
                type: "string",
                description: "Source code or text content to write into this file.",
              },
            },
            required: ["path"],
          },
        },
        planId: {
          type: "string",
          description: "One-time planId returned by 'plan'. Required for 'apply'.",
        },
        content: {
          type: "string",
          description: "Source code or file content for 'edit'.",
        },
        confirmOverwrite: {
          type: "boolean",
          description:
            "Set to true only if the user explicitly approved overwriting existing files.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "appControl",
    description:
      "Controls applications and windows on the user's Windows desktop through Myra's allowlist (VS Code, Notepad, Calculator, Paint, Settings, File Explorer, Snipping Tool, Task Manager, Chrome, Edge, Firefox, Brave, Word, Excel, PowerPoint, Outlook, Teams, WhatsApp, Telegram, Discord, Spotify, Zoom, VLC, Steam). Actions: 'launch' (start an app, or bring it to the front when already running), 'close' (needs a second call with the approvalId after the user confirms), 'minimize', 'maximize', 'restore', 'focus'/'switch', 'cycle' (next running app), 'list' (running apps), 'installed' (what Myra may control here), 'status', 'context' (foreground app, last used app, recent actions), 'openUrl' (http/https URL in a browser), 'openSearch' (Google search in a browser), 'openFolder' (folder in VS Code or File Explorer). 'app' is an app NAME, never a path or executable; use 'this'/'current' for the app in front and 'previous'/'last' for the previously used app.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The app action to perform.",
          enum: [
            "launch",
            "close",
            "minimize",
            "maximize",
            "restore",
            "focus",
            "cycle",
            "list",
            "installed",
            "status",
            "context",
            "openUrl",
            "openSearch",
            "openFolder",
          ],
        },
        app: {
          type: "string",
          description:
            "Application name from Myra's allowlist, e.g. 'chrome', 'vs code', 'notepad', 'word'. Use 'this'/'current' for the app in front and 'previous'/'last' for the previously used app. Never a file path or executable.",
        },
        approvalId: {
          type: "string",
          description:
            "The approvalId returned by an unconfirmed 'close'. Only pass it after the user explicitly agreed to close that app.",
        },
        url: {
          type: "string",
          description: "Absolute http/https URL, used only by 'openUrl'.",
        },
        query: {
          type: "string",
          description: "Search text for 'openSearch', or an app name filter for 'installed'.",
        },
        folder: {
          type: "string",
          description:
            "Absolute path of an existing folder, used only by 'openFolder' (VS Code or File Explorer).",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "taskControl",
    description:
      "Runs a multi-step desktop task as one planned sequence: plan the steps, then execute them one at a time, verifying each step before the next starts. Use it for commands with two or more actions, e.g. 'Open VS Code, then open my project folder', 'Open Chrome and search for Python tutorials', 'Open Notepad and create a new note'. A failed step stops the task and is reported honestly. If any step closes an app, run requires confirmDestructive:true after the user's explicit yes. Actions: 'plan' (validate and summarise, nothing runs), 'run' (execute the planId), 'status' (what Myra is doing right now), 'cancel' (stop before the next step).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The task action to perform.",
          enum: ["plan", "run", "status", "cancel"],
        },
        steps: {
          type: "array",
          description:
            "Ordered steps for 'plan' (max 8). Each step is one desktop action.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                description: "The step type.",
                enum: [
                  "launchApp",
                  "focusApp",
                  "windowAction",
                  "openUrl",
                  "openSearch",
                  "openFolder",
                  "closeApp",
                  "wait",
                ],
              },
              app: {
                type: "string",
                description:
                  "App name from Myra's allowlist for this step (not needed for 'wait').",
              },
              action: {
                type: "string",
                description: "Window action for a windowAction step.",
                enum: ["minimize", "maximize", "restore"],
              },
              url: {
                type: "string",
                description: "http/https URL for an openUrl step.",
              },
              query: {
                type: "string",
                description: "Search text for an openSearch step.",
              },
              folder: {
                type: "string",
                description:
                  "Absolute folder path for an openFolder step. Optional: the active VS Code project is used when omitted.",
              },
              seconds: {
                type: "number",
                description: "Wait time in seconds (0.2-10) for a wait step.",
              },
            },
            required: ["type"],
          },
        },
        planId: {
          type: "string",
          description: "The one-time planId returned by 'plan'. Required for 'run'.",
        },
        confirmDestructive: {
          type: "boolean",
          description:
            "true only after the user explicitly approved the destructive step(s) (closing an app).",
        },
        reason: {
          type: "string",
          description: "Optional short reason for 'cancel'.",
        },
      },
      required: ["action"],
    },
  },
];

// ---------------------------------------------------------------------------
// WebSocket message helpers (keep sends typesafe and DRY)
// ---------------------------------------------------------------------------

function sendJSON(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

function handleConnection(
  ws: WebSocket,
  provider: AIProvider,
  handoff: ToolHandoff | null,
  sessions: Map<string, ConnectionContext>,
  electronMode: boolean,
  smokeMode: boolean,
  remoteRuntime: RemoteRuntime | null = null,
  remoteAudioBridge: RemoteAudioBridge | null = null,
  intelligence: IntelligenceService | null = null,
  interviewId: string | null = null,
  interviewInstruction: string | null = null
): void {
  console.log("[server] Client connected to WebSocket. Initialising AI session...");

  // T5R Phase B: per-connection session identifier. It binds registrations,
  // tickets and completions to THIS connection end-to-end. It is a
  // correlation identifier, not a capability: knowing it grants nothing.
  const sessionId = crypto.randomBytes(16).toString("hex");

  const ctx: ConnectionContext = { ws, pending: new Map(), session: null };
  sessions.set(sessionId, ctx);
  remoteRuntime?.desktopConnected(sessionId);

  /** Look up a tracked call by the id the renderer echoes back to us. */
  function findPending(id: string): PendingCallEntry | undefined {
    const direct = ctx.pending.get(id);
    if (direct) return direct;
    for (const entry of ctx.pending.values()) {
      if (entry.responseId === id) return entry;
    }
    return undefined;
  }

  // T5R Phase B smoke hook: pre-register synthetic pending calls so the
  // completion path can be exercised end-to-end without a live Gemini
  // toolCall. Three entries: #1 for the valid-acceptance + replay checks,
  // #2 for the digest-tamper check, #3 for the binding-mismatch check
  // (each terminal registration is single-use). Smoke-only; never active
  // in normal runs.
  if (smokeMode && electronMode) {
    for (const id of ["smoke-completion-1", "smoke-completion-2", "smoke-completion-3"]) {
      ctx.pending.set(id, {
        name: "getSystemTime",
        argsDigest: sha256Hex("{}"),
        mainExecuted: true,
        deadlineNs: process.hrtime.bigint() + BigInt(SERVER_REGISTRATION_TTL_MS) * BigInt(1_000_000),
        done: false,
        responseId: id,
      });
    }
    console.log("[smoke] SESSION_ID=" + sessionId);
  }

  /**
   * T5R B.1: single registration + tracking path for every Gemini-issued tool
   * call (used by onToolCall and the smoke-only regression hook).
   *
   *  - Duplicate callIds NEVER overwrite an existing entry (B.3): the existing
   *    entry's lifecycle stays authoritative. Expired duplicates are replaced.
   *  - Failed registrations of MAIN-EXECUTED tools are closed server-side
   *    (MED-1): the entry is marked terminal FIRST, then exactly ONE
   *    synthesized error response is sent to Gemini directly. The renderer
   *    never participates — there is no echo mechanism anymore.
   *  - Pipe outages never bypass tracking: the call is still registered in
   *    ctx.pending (fail-closed, HIGH-1); main-executed tools get the
   *    synthesized error, renderer-executed tools keep legacy acceptance.
   */
  async function registerAndTrackCall(call: {
    id?: unknown;
    name?: unknown;
    args?: unknown;
  }): Promise<{ handoffField: { ticket: string } | { error: string } | undefined }> {
    const rawId = String(call?.id ?? "");
    // Registry key: the model id when it is a safe key, otherwise a generated
    // one. Gemini still receives the ORIGINAL id (responseId) so the model can
    // correlate its tool response.
    const callId = REGISTRY_ID_RX.test(rawId) ? rawId : "mdl_" + crypto.randomBytes(8).toString("hex");
    const responseId = rawId || callId;
    const name = String(call?.name ?? "");

    // Lazy sweep: drop expired registrations so the per-connection pending
    // map cannot grow unbounded across a long session.
    const nowNs = process.hrtime.bigint();
    for (const [k, e] of ctx.pending) {
      if (nowNs > e.deadlineNs) ctx.pending.delete(k);
    }

    // Duplicate callId: preserve the existing entry untouched.
    if (ctx.pending.has(callId)) {
      console.log("[server] duplicate toolCall id preserved callId=" + JSON.stringify(callId));
      if (smokeMode) console.log("[smoke] DUPLICATE_CALLID_PRESERVED callId=" + JSON.stringify(callId));
      return { handoffField: { error: "duplicateCallId" } };
    }

    const digest = digestToolArgs(call?.args);
    let handoffField: { ticket: string } | { error: string } | undefined;
    let regMainExecuted = false;
    let regFailureReason: string | undefined;
    if (handoff && handoff.isActive()) {
      try {
        const reg = await handoff.registerPendingCall(callId, name, call?.args, sessionId);
        if (reg.outcome === "ok") {
          handoffField = { ticket: reg.ticket };
          regMainExecuted = reg.mainExecuted;
        } else {
          handoffField = { error: reg.reason };
          regFailureReason = reg.reason;
        }
      } catch {
        handoffField = { error: "handoffError" };
        regFailureReason = "handoffError";
      }
    } else {
      // Pipe down (or never connected): fail closed. Main-executed tools get
      // a server-synthesized error below; renderer-executed tools keep
      // legacy acceptance for this call.
      handoffField = { error: "handoffUnavailable" };
      regFailureReason = "handoffUnavailable";
    }

    const isMainExecuted = MAIN_EXECUTED_TOOLS.has(name);
    const registrationTtlMs = LONG_RUNNING_TOOLS.has(name)
      ? LONG_RUNNING_REGISTRATION_TTL_MS
      : SERVER_REGISTRATION_TTL_MS;
    const entry: PendingCallEntry = {
      name,
      argsDigest: digest,
      mainExecuted: regMainExecuted || isMainExecuted,
      deadlineNs: process.hrtime.bigint() + BigInt(registrationTtlMs) * BigInt(1_000_000),
      done: false,
      responseId,
    };
    ctx.pending.set(callId, entry);

    if (isMainExecuted && regFailureReason !== undefined) {
      entry.done = true; // terminal BEFORE the response is generated
      try {
        ctx.session?.sendToolResponse([{ id: responseId, name, response: { output: { error: regFailureReason } } }]);
        console.log(
          "[server] synthesized tool error for failed registration callId=" +
            JSON.stringify(callId) +
            " error=" +
            regFailureReason
        );
        if (smokeMode) {
          console.log("[smoke] REGFAIL_SYNTHESIZED callId=" + JSON.stringify(callId) + " error=" + regFailureReason);
        }
      } catch (err: any) {
        console.error("[server] Failed to deliver synthesized tool error:", err?.message ?? err);
      }
    }
    return { handoffField };
  }

  // Immediately signal that we are connecting.
  sendJSON(ws, { type: "status", state: "connecting" });

  // --- Interview voice authority ------------------------------------------
  // The backend engine owns interview progression. In a voice interview the
  // live model only SPEAKS engine questions and captures the candidate's
  // speech; the server evaluates the stored transcript and sends the next
  // engine question through the SAME Gemini Live session (sendText).
  let interviewAnswerBuffer = "";
  let interviewAnswerTimer: NodeJS.Timeout | null = null;
  let interviewEvaluating = false;
  let interviewClosed = false;

  const speakEngineQuestion = (session: AIProviderSession, question: string) => {
    try {
      if (typeof session.sendText !== "function") {
        console.warn("[interview] provider cannot carry the engine question; voice interview cannot advance");
        return;
      }
      session.sendText(engineQuestionPrompt(question));
    } catch (err) {
      console.warn(
        "[interview] failed to deliver the engine question:",
        err instanceof Error ? err.message.slice(0, 120) : "unknown"
      );
    }
  };

  const flushInterviewAnswer = () => {
    if (!intelligence || !interviewId || interviewEvaluating || interviewClosed) return;
    const answer = interviewAnswerBuffer.replace(/\s+/g, " ").trim();
    if (!answer) return;
    interviewAnswerBuffer = "";
    interviewEvaluating = true;
    void intelligence
      .answerVoice(interviewId, answer)
      .then((result) => {
        if (interviewClosed) return;
        sendJSON(ws, {
          type: "interviewProgress",
          finished: result.finished,
          assessment: result.assessment,
        });
        if (result.nextQuestion && ctx.session) {
          speakEngineQuestion(ctx.session, result.nextQuestion.text);
        }
      })
      .catch((err: unknown) => {
        console.warn(
          "[interview] answer evaluation failed:",
          err instanceof Error ? err.message.slice(0, 160) : "unknown"
        );
        sendJSON(ws, {
          type: "interviewError",
          message: "The interview engine could not evaluate that answer. Please answer again.",
        });
      })
      .finally(() => {
        interviewEvaluating = false;
        if (!interviewClosed && interviewAnswerBuffer.trim()) {
          interviewAnswerTimer = setTimeout(flushInterviewAnswer, 600);
        }
      });
  };

  const scheduleInterviewAnswer = () => {
    if (interviewAnswerTimer) clearTimeout(interviewAnswerTimer);
    // Wait for a short silence so a sentence split across transcription
    // segments is evaluated once, as one answer.
    interviewAnswerTimer = setTimeout(flushInterviewAnswer, 1400);
  };

  const clearInterviewTimers = () => {
    if (interviewAnswerTimer) clearTimeout(interviewAnswerTimer);
    interviewAnswerTimer = null;
  };

  // Open the provider session asynchronously.
  provider
    .createSession(
      {
        systemInstruction: interviewInstruction
          ? `${MYRA_SYSTEM_INSTRUCTION}\n\n---\n${interviewInstruction}`
          : MYRA_SYSTEM_INSTRUCTION,
        tools: BUILT_IN_TOOLS,
        voiceConfig: { voiceName: "Kore" },
      },
      {
        onAudio(base64PCMData) {
          // Model audio is flowing: gate the phone uplink (see routes.ts) so
          // speaker echo or room noise cannot interrupt Myra mid-sentence.
          remoteRuntime?.setMyraSpeaking(true);
          sendJSON(ws, { type: "audio", data: base64PCMData });
        },

        onToolCall(functionCalls) {
          // T5R B.1: mode-aware. Website mode keeps the EXACT legacy frame
          // (no extra field, no tracking). Electron mode ALWAYS tracks calls
          // and attaches handoff fields — even during pipe outages — so the
          // toolResponse gate below can fail closed (HIGH-1 fix).
          const calls = Array.isArray(functionCalls) ? functionCalls : [];
          if (!electronMode) {
            sendJSON(ws, { type: "toolCall", functionCalls });
            return;
          }
          void (async () => {
            const frames: unknown[] = [];
            for (const call of calls) {
              const { handoffField } = await registerAndTrackCall(call);
              frames.push({ ...call, handoff: handoffField });
            }
            sendJSON(ws, { type: "toolCall", functionCalls: frames });
          })().catch((err) => {
            console.error("[server] Tool call handoff failed:", err?.message ?? err);
            // Fail-safe: forward the original (legacy) frame so the voice
            // conversation itself is never broken by handoff hiccups.
            // Renderer responses for these ids are still validated against
            // ctx.pending by the fail-closed toolResponse gate.
            sendJSON(ws, { type: "toolCall", functionCalls: calls });
          });
        },

        onInterrupted() {
          console.log("[server] Model speech interrupted");
          remoteRuntime?.setMyraSpeaking(false);
          sendJSON(ws, { type: "interrupted" });
        },

        onTurnComplete() {
          remoteRuntime?.setMyraSpeaking(false);
          sendJSON(ws, { type: "turnComplete" });
        },

        onError(error) {
          console.error("[server] Provider error:", error.message);
          sendJSON(ws, { type: "error", message: "AI provider error: " + error.message });
        },

        onTranscript(role, text) {
          const mapped = role === "model" ? "interviewer" : "candidate";
          // The renderer mirrors the transcript for live captions only.
          sendJSON(ws, { type: "transcript", role: mapped, text });
          if (intelligence && interviewId) {
            // Interview voice is engine-authoritative: only the candidate's
            // words are buffered. Model speech is never persisted, so an
            // improvised question can never enter the session record.
            if (role === "user") {
              const incoming = String(text).replace(/\s+/g, " ").trim();
              if (incoming) {
                if (incoming.startsWith(interviewAnswerBuffer)) {
                  // Cumulative transcription: the newest chunk contains the turn.
                  interviewAnswerBuffer = incoming;
                } else if (!interviewAnswerBuffer.endsWith(incoming)) {
                  interviewAnswerBuffer = `${interviewAnswerBuffer} ${incoming}`.trim();
                }
                interviewAnswerBuffer = interviewAnswerBuffer.slice(-4000);
                scheduleInterviewAnswer();
              }
            }
          }
        },

        onClose(reason) {
          console.log("[server] Provider connection closed:", reason);
          remoteRuntime?.clearSessionEstablished(sessionId);
          remoteAudioBridge?.detach(sessionId);
          sendJSON(ws, {
            type: "status",
            state: "disconnected",
            reason: reason ?? "Provider connection closed",
          });
        },
      }
    )
    .then((s) => {
      ctx.session = s;
      remoteRuntime?.markSessionEstablished(sessionId);
      // Phase 2: expose THIS existing session as the phone audio sink. The
      // remote side never creates a second Gemini session.
      remoteAudioBridge?.attach(sessionId, {
        sendAudio: (base64PCM: string) => s.sendAudio(base64PCM),
      });
      console.log("[server] AI session established");
      sendJSON(ws, { type: "status", state: "connected" });
    })
    .catch((err: Error) => {
      remoteRuntime?.clearSessionEstablished(sessionId);
      console.error("[server] Failed to create AI session:", err.message);
      sendJSON(ws, {
        type: "status",
        state: "error",
        message: err.message || "Failed to establish AI session. Check server configuration.",
      });
      ws.close();
    });

  // Handle messages arriving from the browser.
  ws.on("message", (rawMessage) => {
    try {
      const msg = JSON.parse(rawMessage.toString());

      if (msg.type === "audio" && msg.data) {
        ctx.session?.sendAudio(msg.data);
      } else if (msg.type === "toolResponse" && msg.functionResponses) {
        if (electronMode) {
          // T5R B.1 (HIGH-1 fix): mode-aware and fail-closed. Validation is
          // keyed on ELECTRON MODE, never on handoff.isActive() — a pipe
          // outage must not silently downgrade this connection to unvalidated
          // legacy forwarding. Renderer-authored results for main-executed
          // tools are rejected unconditionally (results arrive only via
          // authenticated completions); unknown/unregistered callIds are
          // rejected; terminal entries are rejected.
          const all = Array.isArray(msg.functionResponses) ? msg.functionResponses : [];
          const accepted: FunctionResponse[] = [];
          for (const r of all) {
            const id = String((r as any)?.id ?? "");
            const entry = findPending(id);
            if (!entry) {
              console.log("[server] [tamper] DROPPED_TOOL_RESPONSE_UNREGISTERED callId=" + JSON.stringify(id));
              continue;
            }
            if (entry.done) {
              console.log("[server] [tamper] DROPPED_TOOL_RESPONSE_TERMINAL callId=" + JSON.stringify(id));
              continue;
            }
            if (entry.mainExecuted || MAIN_EXECUTED_TOOLS.has(entry.name)) {
              console.log("[server] [tamper] DROPPED_TOOL_RESPONSE_MAIN_EXECUTED callId=" + JSON.stringify(id));
              continue;
            }
            entry.done = true;
            accepted.push(r);
          }
          if (accepted.length > 0) {
            ctx.session?.sendToolResponse(accepted);
          } else if (all.length > 0) {
            console.log("[server] [tamper] ALL toolResponses dropped (fail-closed)");
          }
          return;
        }
        // Legacy path (standalone website, no Electron) — unchanged semantics.
        ctx.session?.sendToolResponse(msg.functionResponses);
      } else if (electronMode && smokeMode && msg.type === "smokeRegFail" && typeof msg.callId === "string") {
        // Smoke-only regression hook (Phase B.1): exercises the registration +
        // tracking path (including failure synthesis and duplicate handling)
        // without a live Gemini toolCall. Never active in normal runs.
        void registerAndTrackCall({ id: msg.callId, name: "getSystemTime", args: {} }).catch(() => {});
      }
    } catch (err) {
      console.error("[server] Error processing client message:", err);
    }
  });

  // Clean up when the client disconnects.
  ws.on("close", () => {
    console.log("[server] Client disconnected. Closing AI session...");
    interviewClosed = true;
    clearInterviewTimers();
    sessions.delete(sessionId);
    remoteRuntime?.desktopDisconnected(sessionId);
    remoteAudioBridge?.detach(sessionId);
    ctx.session?.close();
    ctx.session = null;
  });
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

/**
 * T5R Phase B: verify an HMAC-verified completion against THIS server's own
 * registration state and, when valid, forward the result to Gemini.
 *
 * Verification sequence (fail-closed, each step logs a tamper marker):
 *   1. HMAC            — verified in handoff.ts before this is called
 *   2. sessionId route — receipt must name a live connection
 *   3. registry        — callId must be registered on that connection
 *   4. binding         — toolName + argsDigest must match the registration
 *   5. deadline        — server-side monotonic expiry (authoritative)
 *   6. terminal/nonce  — single-use, replay-rejected
 *   7. digest          — resultDigest must hash the carried result
 */
function handleCompletion(receipt: CompletionReceipt, sessions: Map<string, ConnectionContext>, consumedNonces: Set<string>): void {
  // Structural gate before anything else (B.3: protocol version pinned).
  if (
    receipt?.kind !== "completion" ||
    receipt.v !== 1 ||
    typeof receipt.callId !== "string" ||
    typeof receipt.toolName !== "string" ||
    typeof receipt.sessionId !== "string" ||
    typeof receipt.argsDigest !== "string" ||
    (receipt.executionStatus !== "success" &&
      receipt.executionStatus !== "execution_error" &&
      receipt.executionStatus !== "denied" &&
      receipt.executionStatus !== "cancelled")
  ) {
    console.log("[server] [tamper] COMPLETION_MALFORMED");
    return;
  }

  const ctx = sessions.get(receipt.sessionId);
  if (!ctx) {
    console.log("[server] [tamper] COMPLETION_UNKNOWN_SESSION callId=" + JSON.stringify(receipt.callId));
    return;
  }
  const entry = ctx.pending.get(receipt.callId);
  if (!entry) {
    console.log("[server] [tamper] COMPLETION_UNREGISTERED callId=" + JSON.stringify(receipt.callId));
    return;
  }
  if (
    entry.name !== receipt.toolName ||
    entry.argsDigest === null ||
    !timingSafeEq(entry.argsDigest, receipt.argsDigest)
  ) {
    console.log("[server] [tamper] COMPLETION_BINDING_MISMATCH callId=" + JSON.stringify(receipt.callId));
    return;
  }
  // Server-side monotonic deadline is authoritative.
  if (process.hrtime.bigint() > entry.deadlineNs) {
    ctx.pending.delete(receipt.callId);
    console.log("[server] [tamper] COMPLETION_EXPIRED callId=" + JSON.stringify(receipt.callId));
    return;
  }
  // Terminal state: any completion (valid or not) closes the registration.
  if (entry.done) {
    console.log("[server] [tamper] COMPLETION_TERMINAL callId=" + JSON.stringify(receipt.callId));
    return;
  }
  // Replay cache (defense-in-depth beneath the terminal-state check).
  if (consumedNonces.has(receipt.nonce)) {
    entry.done = true;
    console.log("[server] [tamper] COMPLETION_TERMINAL callId=" + JSON.stringify(receipt.callId) + " (nonce replay)");
    return;
  }
  if (!MAIN_EXECUTED_TOOLS.has(entry.name)) {
    // Completions only exist for main-executed tools.
    console.log("[server] [tamper] COMPLETION_NOT_MAIN_EXECUTED callId=" + JSON.stringify(receipt.callId));
    return;
  }

  // Result integrity: the signed digest must match the carried result.
  if (receipt.executionStatus === "success" || receipt.executionStatus === "execution_error") {
    if (typeof receipt.resultDigest !== "string" || !/^[0-9a-f]{64}$/.test(receipt.resultDigest)) {
      console.log("[server] [tamper] COMPLETION_DIGEST_MISMATCH callId=" + JSON.stringify(receipt.callId));
      return;
    }
    const canonical = strictCanonicalJson(receipt.result);
    if (canonical === null || sha256Hex(canonical) !== receipt.resultDigest) {
      console.log("[server] [tamper] COMPLETION_DIGEST_MISMATCH callId=" + JSON.stringify(receipt.callId));
      return;
    }
  }

  // Commit: terminal state is RETAINED (not deleted) so replays report
  // COMPLETION_TERMINAL; the entry self-expires at its deadline via the sweep.
  entry.done = true;
  consumedNonces.add(receipt.nonce);
  if (consumedNonces.size > NONCE_CACHE_MAX) {
    // Bounded FIFO eviction.
    const first = consumedNonces.values().next().value;
    if (first !== undefined) consumedNonces.delete(first);
  }

  const output =
    receipt.executionStatus === "success"
      ? receipt.result
      : { error: "toolExecutionFailed", detail: receipt.reason ?? receipt.executionStatus };
  try {
    ctx.session?.sendToolResponse([{ id: entry.responseId || receipt.callId, name: receipt.toolName, response: { output } }]);
    sendJSON(ctx.ws, {
      type: "toolCompletion",
      callId: entry.responseId || receipt.callId,
      name: receipt.toolName,
      status: receipt.executionStatus,
      output,
    });
    console.log(
      "[server] Completion accepted callId=" + JSON.stringify(receipt.callId) + " status=" + receipt.executionStatus
    );
  } catch (err: any) {
    console.error("[server] Failed to forward completion to Gemini:", err?.message ?? err);
    return;
  }
  console.log("[smoke] COMPLETION_ACCEPTED");
}

/** Metadata-only execution status relay (e.g. state:"executing") to the renderer. */
function handleExecStatus(frame: { callId: string; sessionId: string; state: string }, sessions: Map<string, ConnectionContext>): void {
  if (frame.state !== "executing") return; // metadata-only allowlist
  const ctx = sessions.get(frame.sessionId);
  if (!ctx) return;
  try {
    sendJSON(ctx.ws, { type: "toolStatus", callId: frame.callId, state: frame.state });
  } catch {
    /* socket gone */
  }
}

export async function startServer(
  provider: AIProvider,
  config: ServerConfig,
  usage?: GeminiUsageTracker
): Promise<ReturnType<typeof http.createServer>> {
  const app = express();
  const server = http.createServer(app);
  const geminiUsage = usage ?? new GeminiUsageTracker(config.intelligenceDataDir);

  const distPath = process.env.MYRA_DIST_DIR
    ? path.resolve(process.env.MYRA_DIST_DIR)
    : path.join(process.cwd(), "dist");

  // Development Vite instance. Created BEFORE the remote router so /remote can
  // run remote.html through Vite's HTML transform (React refresh preamble and
  // module graph). Serving that file raw made the remote entry module throw and
  // left the phone with a blank white page. Middleware is still mounted after
  // the API routes, further below.
  let devVite: ViteDevServer | null = null;
  if (config.nodeEnv !== "production") {
    console.log("[server] Starting development server with Vite middleware...");
    const { createServer: createViteServer } = await import("vite");
    devVite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
  }

  // -------------------------------------------------------------------------
  // Phase 1 remote control surface (status + pairing only)
  // -------------------------------------------------------------------------
  const remoteEnabled = config.remoteEnabled && !!config.wsAuthToken;
  const remoteRuntime = remoteEnabled
    ? new RemoteRuntime({ enabled: true, publicUrl: config.remotePublicUrl })
    : null;
  const pairing = remoteEnabled ? new PairingManager() : null;
  const remoteAudioBridge = remoteEnabled ? new RemoteAudioBridge() : null;

  if (remoteEnabled && remoteRuntime && pairing) {
    app.use(
      createRemoteRouter({
        runtime: remoteRuntime,
        pairing,
        desktopToken: config.wsAuthToken as string,
        publicUrl: config.remotePublicUrl,
        projectRoot: process.cwd(),
        distDir: distPath,
        isProduction: config.nodeEnv === "production",
        trustProxy: config.trustProxy,
        transformHtml: devVite
          ? (html: string) => devVite!.transformIndexHtml("/remote", html)
          : undefined,
      })
    );
  } else {
    // Standalone website mode: /remote must not fall through to the SPA.
    app.all(["/remote", "/remote/*", "/api/remote/*"], (_req, res) => {
      res.status(404).json({ ok: false, error: "remoteDisabled" });
    });
  }

  // The phone dashboard is served only at /remote. The built entry file must
  // never be reachable directly: static/Vite middleware would otherwise serve
  // /remote.html (and cache it) even in standalone mode, bypassing the
  // enabled/disabled policy above.
  app.all(["/remote.html", "/remote.html/*"], (_req, res) => {
    res.status(404).json({ ok: false, error: remoteEnabled ? "notFound" : "remoteDisabled" });
  });

  // -------------------------------------------------------------------------
  // Local Gemini usage counter (live sessions + generateContent requests)
  // -------------------------------------------------------------------------
  app.get("/api/gemini/usage", (req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    if (config.electronMode) {
      const supplied =
        typeof req.headers["x-myra-desktop-token"] === "string"
          ? req.headers["x-myra-desktop-token"]
          : "";
      if (!config.wsAuthToken || !timingSafeEq(supplied, config.wsAuthToken)) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
      }
    } else {
      const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "localhost") {
        res.status(403).json({ ok: false, error: "localOnly" });
        return;
      }
    }

    const origin = req.headers.origin;
    if (typeof origin === "string" && origin) {
      let sameHost = false;
      try {
        sameHost = new URL(origin).host === req.headers.host;
      } catch {
        sameHost = false;
      }
      if (!sameHost) {
        res.status(403).json({ ok: false, error: "originRejected" });
        return;
      }
    }

    res.json({ ok: true, usage: geminiUsage.summary() });
  });

  // -------------------------------------------------------------------------
  // Project Intelligence + Interview Mode (local-only API surface)
  // -------------------------------------------------------------------------
  let intelligence: IntelligenceService | null = null;
  if (config.intelligenceEnabled) {
    const textModel = config.geminiApiKey
      ? new GeminiTextModel(config.geminiApiKey, config.intelligenceModel, geminiUsage)
      : null;
    intelligence = new IntelligenceService({
      dataDir: config.intelligenceDataDir,
      approvedRootsFile: config.approvedProjectsFile,
      electronMode: config.electronMode,
      model: textModel,
      requestCap: config.intelligenceRequestCap,
    });
    try {
      await intelligence.init();
      app.use(
        createIntelligenceRouter({
          service: intelligence,
          electronMode: config.electronMode,
          desktopToken: config.wsAuthToken,
        })
      );
      if (!textModel) {
        console.warn(
          "[intelligence] GEMINI_API_KEY is missing: project import works, analysis/interviews are unavailable."
        );
      }
    } catch (err) {
      console.error(
        "[intelligence] Failed to initialise Project Intelligence:",
        err instanceof Error ? err.message : String(err)
      );
      intelligence = null;
    }
  } else {
    app.all(["/api/intelligence", "/api/intelligence/*"], (_req, res) => {
      res.status(404).json({ ok: false, error: "intelligenceDisabled" });
    });
  }

  // Single upgrade dispatcher so /ws and /remote/ws can coexist on one server.
  const wss = new WebSocketServer({ noServer: true });
  const remoteWs =
    remoteEnabled && remoteRuntime && pairing
      ? createRemoteWebSocketServer({
          runtime: remoteRuntime,
          pairing,
          publicUrl: config.remotePublicUrl,
          audioBridge: remoteAudioBridge,
        })
      : null;

  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://127.0.0.1").pathname;
    } catch {
      pathname = "";
    }

    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      return;
    }
    if (pathname === "/remote/ws" && remoteWs) {
      if (!remoteWs.handleUpgrade(req, socket, head)) socket.destroy();
      return;
    }
    socket.destroy();
  });

  server.on("close", () => {
    remoteWs?.close();
    remoteRuntime?.dispose();
    pairing?.dispose();
    remoteAudioBridge?.dispose();
  });

  // T5R Phase B: live connections by sessionId (completion routing) and a
  // bounded replay cache of consumed completion nonces.
  const sessions = new Map<string, ConnectionContext>();
  const consumedNonces = new Set<string>();

  // T5.0/T5R: Handoff client (Electron mode only). Standalone website runs get
  // exactly the legacy behaviour: no handoff, no ticket fields, no filtering.
  let handoff: ToolHandoff | null = null;
  if (config.electronMode && config.handoffPipe && config.handoffNonce && config.receiptKey) {
    handoff = createHandoffClient({
      pipeName: config.handoffPipe,
      nonce: config.handoffNonce,
      receiptKey: config.receiptKey,
      onCompletion: (receipt) => handleCompletion(receipt, sessions, consumedNonces),
      onExecStatus: (frame) => handleExecStatus(frame, sessions),
    });
    // Warm the pipe connection (non-fatal on failure). The warmup ticket is
    // discarded; its unused registration self-expires inside the authority.
    void handoff
      .registerPendingCall("__warmup__", "getSystemTime", {}, "__warmup__")
      .then((r) => {
        if (r.outcome === "ok") {
          console.log("[server] Handoff pipe connected; desktop tool routing enabled");
        }
      })
      .catch(() => {});
  }

  // Health endpoint — exposes provider name but NOT the API key, NOT the token.
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: config.nodeEnv,
      provider: provider.name,
      wsAuth: config.electronMode ? "token" : config.websiteMode,
    });
  });

  // Bridge each WebSocket client to the AI provider.
  wss.on("connection", (ws, req) => {
    // T5.0: authenticated local sessions. In Electron runs the desktop server
    // REQUIREs the per-run token; unauthenticated connections are rejected
    // before any AI session or tool path can begin.
    const authRequired = config.electronMode || config.websiteMode === "token";
    if (authRequired) {
      let supplied = "";
      try {
        const url = new URL(req.url ?? "", "http://127.0.0.1");
        supplied = url.searchParams.get("auth") ?? "";
      } catch {
        supplied = "";
      }
      const valid =
        typeof supplied === "string" &&
        supplied.length > 0 &&
        !!config.wsAuthToken &&
        timingSafeEq(supplied, config.wsAuthToken);
      if (!valid) {
        console.log("[server] [auth] REJECTED WebSocket connection (missing or invalid token)");
        sendJSON(ws, { type: "status", state: "error", message: "Authentication failed." });
        ws.close();
        return;
      }
    }
    // Interview Mode rides on the SAME /ws session. The interview id only
    // selects an extra system instruction; a bad id falls back to the normal
    // assistant, so the voice pipeline can never be broken by this feature.
    let interviewId: string | null = null;
    if (intelligence) {
      try {
        interviewId = new URL(req.url ?? "", "http://127.0.0.1").searchParams.get("interview");
      } catch {
        interviewId = null;
      }
    }

    const start = (instruction: string | null) =>
      handleConnection(
        ws,
        provider,
        handoff,
        sessions,
        config.electronMode === true,
        config.smokeMode === true,
        remoteRuntime,
        remoteAudioBridge,
        intelligence,
        interviewId,
        instruction
      );

    if (intelligence && interviewId) {
      void intelligence
        .voiceInstruction(interviewId)
        .then((instruction) => start(instruction))
        .catch(() => start(null));
      return;
    }

    start(null);
  });

  // Vite dev middleware or static file serving for production.
  if (devVite) {
    app.use(devVite.middlewares);
  } else {
    console.log("[server] Starting production server...");
    // Electron packaged build: MYRA_DIST_DIR points at the asar-unpacked dist
    // directory (real files on disk). Unset -> original behaviour unchanged.
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(config.port, config.host, () => {
    console.log(`[server] Myraa AI server listening on http://${config.host}:${config.port}`);
    console.log(`[server] Provider: ${provider.name}`);
  });

  return server;
}
