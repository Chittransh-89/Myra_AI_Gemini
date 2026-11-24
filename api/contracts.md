# Myra AI — API Contracts

> Generated from the implementation on 2026-11-23. See
> [endpoints.md](./endpoints.md) for the route inventory and
> [errors.md](./errors.md) for failure codes.

## 1. Conventions

- HTTP responses are JSON unless the route serves HTML (`/`, `/remote`,
  `/remote.html` fallback, production SPA fallback).
- Success responses use `ok: true`. Error responses use
  `ok: false` plus `error` and (on intelligence routes) `message`.
- Timestamps are ISO-8601 strings in persisted intelligence objects; remote
  runtime timestamps are Unix milliseconds.
- IDs are prefixed and validated:
  - projects: `proj_[a-f0-9]{8,32}`
  - interviews: `itv_[a-f0-9]{8,32}`
  - reports: `rep_[a-f0-9]{8,32}`
  - pairing sessions: 16 hex characters
- There is no API version header. WebSocket tickets/receipts use `v: 1`;
  stored intelligence documents use `version: 1`.
- CORS is not enabled. There is no `Access-Control-Allow-Origin`; the
  intelligence and remote routes instead reject foreign `Origin` values.
- Intelligence responses are always `Cache-Control: no-store`.
- Remote pairing responses are always `Cache-Control: no-store` and
  `Pragma: no-cache`.

## 2. Authentication contracts

### 2.1 Desktop token (HTTP)

```http
x-myra-desktop-token: <MYRA_WS_TOKEN>
```

Required by `/api/remote/pairing*` and by `/api/intelligence/*` when
`MYRA_ELECTRON=1`. Comparison is constant-time. The token is a 32-byte random
hex string generated per Electron run and never written to disk.

### 2.2 Desktop token (WebSocket)

```text
ws://127.0.0.1:3000/ws?auth=<MYRA_WS_TOKEN>&interview=<optional itv id>
```

The token is read from the `auth` query parameter. In Electron mode, or when
`MYRA_WEBSITE_MODE=token`, a missing/wrong token produces:

```json
{ "type": "status", "state": "error", "message": "Authentication failed." }
```

and the socket is closed. In legacy website mode (`MYRA_WEBSITE_MODE=open`,
non-Electron), no token is required.

The app deliberately never logs the authenticated URL. Query-string tokens can
still appear in proxy logs or browser diagnostics; keep the server loopback-only.

### 2.3 Phone pairing token

Successful `POST /remote/pair` sets:

```http
Set-Cookie: myra_remote=<256-bit token>; HttpOnly; SameSite=Strict;
            Path=/remote; Max-Age=43200[; Secure]
```

`Secure` is set when the request is HTTPS, when `X-Forwarded-Proto: https` is
present, or when `MYRA_REMOTE_FORCE_SECURE=1`. `SameSite=Strict` and
`Path=/remote` mean the cookie is not sent to `/ws` or `/api/intelligence`.
HTTP routes also accept `Authorization: Bearer <token>`; `/remote/ws` accepts
**only** the cookie, never a query-string token.

Exactly one phone session exists at a time. Pairing a new phone replaces the
previous session and closes its socket with code `4003 sessionRevoked`.

### 2.4 Handoff ticket

A tool call frame from `/ws` in Electron mode carries:

```json
{
  "id": "call-id-from-model",
  "name": "fileControl",
  "args": { "action": "read", "path": "C:\\..." },
  "handoff": { "ticket": "<opaque base64url>" }
}
```

or, when registration failed:

```json
"handoff": { "error": "handoffUnavailable" }
```

The ticket payload is base64url-encoded JSON:

```json
{
  "v": 1,
  "kind": "ticket",
  "callId": "registry-id",
  "toolName": "fileControl",
  "argsDigest": "<sha256 hex>",
  "sessionId": "<connection id>",
  "expNs": "<monotonic deadline as decimal string>",
  "sig": "<HMAC-SHA256 hex>"
}
```

The HMAC key exists only in Electron main. Tickets are single-use and expire
(default 20 s; server registration deadline is 30 s, or 180 s for
`taskControl`).

## 3. HTTP contracts

### 3.1 `GET /api/health`

```json
{
  "status": "ok",
  "mode": "development",
  "provider": "gemini",
  "wsAuth": "token"
}
```

`mode` is `NODE_ENV`; `wsAuth` is `"token"` in Electron/token mode and `"open"`
otherwise. The provider name is exposed; keys and tokens are not.

### 3.2 Remote snapshot (`GET /remote/api/state`, pair response)

```json
{
  "serverTime": 1763900000000,
  "uptimeMs": 123456,
  "remote": {
    "enabled": true,
    "publicUrl": "https://myra-pc.example.ts.net/remote",
    "phoneConnected": true,
    "deviceName": "Pixel 8",
    "connectedAt": 1763899900000
  },
  "pc": {
    "connected": true,
    "lastSeenAt": 1763899990000,
    "clients": 1
  },
  "myra": {
    "state": "ACTIVE",
    "mode": "legacy",
    "speaking": false
  },
  "mic": {
    "source": "phone",
    "defaultSource": "phone",
    "streaming": true
  },
  "error": null
}
```

`myra.state` is `INACTIVE | ACTIVE | STOPPING`. `"legacy"` is fixed in the
current implementation and means "the existing desktop `/ws` session", not a
managed lifecycle. `pc.connected` is true when a desktop client is attached or
the last desktop heartbeat is < 45 s old. The snapshot is read-only; no field
can be set by the phone.

### 3.3 Pairing

Request:

```json
{ "code": "123456", "deviceName": "Pixel 8" }
```

Success:

```json
{
  "ok": true,
  "deviceName": "Pixel 8",
  "expiresAt": 1763943200000,
  "snapshot": { "...": "RemoteSnapshot" }
}
```

Failure:

```json
{ "ok": false, "error": "invalidCode" }
```

`rateLimited` adds `retryAfterMs`. `deviceName` is sanitized to 64 characters,
control characters are stripped, and empty values become `"Phone"`. The code is
6 digits, one-time, and expires after 5 minutes. The session lasts 12 hours.

Desktop pairing response:

```json
{
  "ok": true,
  "enabled": true,
  "code": "123456",
  "expiresAt": 1763943200000,
  "pairedDevice": null,
  "pairedAt": null,
  "remoteUrl": "https://myra-pc.example.ts.net/remote",
  "serverTime": 1763900000000
}
```

`remoteUrl` is `null` when `MYRA_REMOTE_PUBLIC_URL` is unset or malformed. If the
configured value has no path (or `/`), `/remote` is appended.

### 3.4 Intelligence import

`POST /api/intelligence/import/local`

```json
{ "path": "C:\\Projects\\demo" }
```

`POST /api/intelligence/import/github`

```json
{ "url": "https://github.com/owner/repo" }
```

Success (both):

```json
{
  "ok": true,
  "project": {
    "projectId": "proj_ab12cd34ef56",
    "name": "demo",
    "source": {
      "kind": "local",
      "root": "C:\\Projects\\demo",
      "name": "demo"
    },
    "stats": {
      "files": 42,
      "bytes": 182000,
      "chars": 160000,
      "redactions": 3,
      "skipped": 17
    },
    "warnings": [],
    "tree": [{ "path": "src/", "type": "dir" }, { "path": "src/index.ts", "type": "file" }],
    "skipped": [{ "path": "node_modules/", "reason": "excludedDirectory" }],
    "importedAt": "2026-11-23T10:00:00.000Z"
  },
  "aiAvailable": true
}
```

`source` is either the local object above or:

```json
{
  "kind": "github",
  "repoUrl": "https://github.com/owner/repo",
  "owner": "owner",
  "repo": "repo",
  "branch": "main",
  "treeSha": "optional"
}
```

The view returned by import deliberately omits raw file contents: it includes
`tree` (first 400 nodes in the service view), `skipped` (first 120), and stats
only. Raw files remain in memory until analysis (30-minute TTL, max 4 pending).

Local import limits: 200 KB per file, 160 files, 700,000 characters total. The
scanner skips excluded directories, sensitive names/paths, lockfiles, minified
files, binary/media extensions, oversized files, and symlinks. In Electron mode
the root must appear in the approved-roots file written by the native picker.

GitHub import limits: public repositories only, 220 GitHub API requests per
import, 15 s request timeout, same file/character limits. Private repositories
return `privateUnsupported`.

### 3.5 Project knowledge

`POST /api/intelligence/projects/:projectId/analyze` returns:

```json
{ "ok": true, "project": { "...": "ProjectKnowledge" } }
```

`ProjectKnowledge` (all fields required unless noted):

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | schema version |
| `projectId`, `name` | string | identity |
| `source` | object | local/GitHub source descriptor |
| `purpose`, `problem` | string | what it does / problem solved |
| `stack` | string[] | technologies |
| `frontend`, `backend` | string[] | architecture facts |
| `entryPoints`, `keyFunctions` | `EvidenceRef[]` | file/symbol claims |
| `modules` | `{name,path,role}[]` | module map |
| `apiEndpoints` | `{method?,path,file}[]` | route facts |
| `dataModels` | `{name,file,note}[]` | models/tables |
| `auth`, `dataFlow`, `aiIntegration` | string[] | behaviour |
| `externalServices` | string[] | third-party services |
| `dependencies` | `{name,role}[]` | dependency roles |
| `designDecisions` | `DesignDecision[]` | decision + rationale + evidence + confidence |
| `limitations`, `unknowns` | string[] | honest gaps |
| `codeSamples` | `CodeSnippet[]` | short redacted samples |
| `stats` | object | import stats |
| `warnings` | string[] | import warnings |
| `model` | string | text model name |
| `createdAt` | string | ISO timestamp |

`EvidenceRef` is `{file, symbol?, lines?, note?}`. Evidence is filtered against
the imported file set before storage, so the profile cannot cite files that were
never seen. `confidence` is `confirmed | inferred | unknown`.

`GET /api/intelligence/projects` returns summaries:

```json
{
  "ok": true,
  "projects": [
    {
      "projectId": "proj_ab12cd34ef56",
      "name": "demo",
      "sourceKind": "local",
      "sourceLabel": "C:\\Projects\\demo",
      "analyzedAt": "2026-11-23T10:05:00.000Z",
      "stack": ["React", "Express"],
      "files": 42
    }
  ]
}
```

`GET /api/intelligence/projects/:projectId` returns the full profile plus
`interviews: InterviewSummary[]`.

### 3.6 Interviews

Create request:

```json
{ "projectId": "proj_ab12cd34ef56", "type": "full", "difficulty": "medium" }
```

Response:

```json
{
  "ok": true,
  "session": { "...": "InterviewSession" },
  "question": { "...": "InterviewQuestion" }
}
```

`InterviewSession` fields: `version:1`, `id`, `projectId`, `projectName`,
`type`, `difficulty`, `status` (`active|paused|ended`), `stage`, `stagePlan`,
`stageIndex`, `currentQuestion|null`, `questions[]`, `turns[]`, `assessments[]`,
`hintsUsed`, `skips`, `reportId|null`, `createdAt`, `updatedAt`, optional
`endedAt`.

`InterviewTurn`: `{role:"interviewer"|"candidate", text, at, questionId?, source:"text"|"voice"}`.
`AnswerAssessment`: `{correctness:"solid"|"partial"|"vague"|"incorrect", score, missing[], misconceptions[], needsFollowUp, note}`.

Answer request: `{ "answer": "..." }` (max 8000 characters). Response:

```json
{
  "ok": true,
  "session": { "...": "InterviewSession" },
  "assessment": { "...": "AnswerAssessment" },
  "nextQuestion": { "...": "InterviewQuestion" },
  "finished": false
}
```

`nextQuestion` may be `null` and `finished` becomes true when the question cap is
reached or the interview ends. The response is generated by one model call that
both assesses the answer and writes the next question.

| Route | Response payload |
| --- | --- |
| `hint` | `{ok:true, hints:string[]}` (max 3 hints) |
| `explain` | `{ok:true, concept:string, explanation:string}` |
| `skip` | `{ok:true, session, question: InterviewQuestion\|null}` |
| `code` | `{ok:true, samples: CodeSnippet[]}` from the question's evidence |
| `pause` | `{ok:true, session}` (`status:"paused"`) |
| `resume` | `{ok:true, session}` (`status:"active"`, generates a question if none is open) |
| `end` | `{ok:true, session, report}` (idempotent if `reportId` already exists) |
| `transcript` | `{ok:true}` (best-effort) |
| `GET /interviews` | `{ok:true, interviews: InterviewSummary[]}` |
| `GET /interviews/:id` | `{ok:true, session, report: InterviewReport\|null}` |
| `GET /reports/:reportId` | `{ok:true, report}` |

`InterviewSummary`: `{id, projectId, projectName, type, difficulty, status,
createdAt, updatedAt, questionCount, reportId}`.

`InterviewReport` fields: `version:1`, `id`, `interviewId`, `projectId`,
`projectName`, `type`, `difficulty`, `createdAt`, `questions[]`,
`overallScore`, `scores{technicalKnowledge, codeUnderstanding,
architectureUnderstanding, reasoning, communicationClarity}`, `verdict`
(`strong_understanding|architecture_only|memorized|serious_gaps`), `summary`,
`weakAreas[]`, `incorrectAssumptions[]`, `topicsToRevise[]`,
`followUpTopics[]`, `revisionPlan[]`.

## 4. `/ws` — desktop voice and tools

### 4.1 Client → server

| Frame | Shape | Behaviour |
| --- | --- | --- |
| Audio | `{"type":"audio","data":"<base64 PCM16 16 kHz>"}` | Forwarded to the active provider session. Ignored if no session. No size/rate check on this socket. |
| Tool response | `{"type":"toolResponse","functionResponses":[...]}` | In Electron mode only responses whose `id` is registered, non-terminal, and not a main-executed tool are forwarded. Legacy website mode forwards unchanged. |

`functionResponses` entries follow the Gemini shape:
`{id, name, response:{output}}`.

A smoke-only frame `{"type":"smokeRegFail","callId":"..."}` is accepted only when
`MYRA_ELECTRON=1` and `MYRA_SMOKE=1`.

### 4.2 Server → client

| Frame | Shape | Meaning |
| --- | --- | --- |
| Status | `{"type":"status","state":"connecting"}` | Session opening |
| Status | `{"type":"status","state":"connected"}` | Gemini Live session established |
| Status | `{"type":"status","state":"disconnected","reason":"..."}` | Provider closed |
| Status | `{"type":"status","state":"error","message":"..."}` | Authentication or setup failure |
| Audio | `{"type":"audio","data":"<base64 PCM>"}` | Model speech |
| Interrupted | `{"type":"interrupted"}` | VAD interruption |
| Turn complete | `{"type":"turnComplete"}` | Model turn finished |
| Tool call | `{"type":"toolCall","functionCalls":[{id,name,args,handoff?}]}` | Tool invocation request |
| Error | `{"type":"error","message":"AI provider error: ..."}` | Non-fatal provider error |
| Transcript | `{"type":"transcript","role":"interviewer"\|"candidate","text":"..."}` | Interview transcription |
| Tool completion | `{"type":"toolCompletion","callId","name","status","output"}` | Main-executed tool finished |
| Tool status | `{"type":"toolStatus","callId","state":"executing"}` | Execution started |

In Electron mode, a tool call's `handoff` is `{ticket}` or `{error}`. The
renderer passes the ticket to `myraDesktop.executeTool({ticket, name, args})`.
A main-executed tool never accepts a renderer-authored `toolResponse`; its result
arrives only through the signed completion path. `toolCompletion.status` is
`success | execution_error | denied | cancelled`.

### 4.3 `/ws` failure semantics

- Auth failure: `status/error` frame, then close with no application close code.
- Provider close: `status/disconnected` with a reason.
- Provider error: `error` frame; a later close may produce `status/disconnected`.
- Malformed JSON / unsupported frame type: logged server-side, no client error.
- No server-side max payload, origin check, audio byte-rate limit, or per-client
  message limit is configured for `/ws`; see the rate-limit audit.

## 5. `/remote/ws` — phone audio

### 5.1 Client → server

| Frame | Shape | Behaviour |
| --- | --- | --- |
| Request state | `{"type":"requestState"}` | Replies with `remoteState` |
| Ping | `{"type":"ping","ts":123}` | Replies with `pong` |
| Audio | `{"type":"audio","data":"<base64>","seq":1}` | Validated, rate-limited, forwarded to the active desktop session |
| Audio stop | `{"type":"audioStop"}` | Marks phone streaming false |
| Control | `{"type":"control",...}` | Always `notImplemented` |
| Tool frames | `{"type":"toolResponse"\|"toolCall"\|"tool",...}` | Always `forbidden` |

Audio rules:

- Base64 alphabet only, length multiple of 4; no whitespace/URL-safe variants.
- Decoded size must be **≤ 8 KB**, non-empty, even length (PCM16 LE).
- Socket max payload is **64 KB**; a larger frame closes with `1009`.
- Token bucket: **64 KB/s sustained, 48 KB burst**. Excess is dropped, never queued.
- While `myra.speaking` is true, uplink is dropped and `streaming` becomes false.
- When no desktop `/ws` session is attached, audio gets `sessionUnavailable`.
- Errors are throttled to one every 2 s per socket; accepted audio marks
  streaming true and an idle watchdog clears it after 2 s.

### 5.2 Server → client

| Frame | Shape |
| --- | --- |
| State | `{"type":"remoteState","snapshot":RemoteSnapshot}` on connect, request, and every runtime change |
| Pong | `{"type":"pong","ts":<client ts or null>,"serverTime":<ms>}` |
| Audio ack | `{"type":"audioAck","seq":<client seq or null>,"bytes":<decoded bytes>}` |
| Error | `{"type":"error","code":"...","message":"..."}` |

### 5.3 Close codes

| Code | Reason | Meaning |
| --- | --- | --- |
| `1000` | normal | Client closed |
| `1001` | `serverClosing` | Server shutting down |
| `1008` | `unauthorized` | No pairing session attached to an upgraded socket (defensive) |
| `1009` | `messageTooLarge` | Frame > 64 KB or decoded audio > 8 KB |
| `4001` | `replaced` | A newer socket for the same phone session replaced this one |
| `4003` | `sessionRevoked` | Pairing was revoked, replaced, or expired |

A failed `/remote/ws` upgrade returns a raw HTTP error
`{"ok":false,"error":"originRejected"}` (403) or
`{"ok":false,"error":"unauthorized"}` (401), then closes the socket.

## 6. Tool contracts

All tools are declared to Gemini in `src/server/index.ts`. In Electron mode,
every tool is main-executed; in standalone website mode the legacy renderer path
remains. Tool args are validated again by the relevant controller or by the
Handoff Authority; the schemas below are the model-facing contract.

| Tool | Actions / purpose | Key arguments |
| --- | --- | --- |
| `getSystemTime` | Local date/time | none |
| `openWebsite` | Open an absolute URL | `url`, `name?` |
| `browserControl` | YouTube/browser window control | `action`, `query?`, `url?`, `direction?`, `amount?`, `index?`, `state?`, `seconds?`, `minutes?`, `level?`, `step?`, `target?`, `windowState?` |
| `whatsappControl` | WhatsApp Web prepare/send | `action` (`status|prepare|send`), `phone?`, `message?`, `approvalId?` |
| `phoneControl` | Phone Link status/open | `action` (`status|open`) |
| `fileControl` | File picker/read/search/compare | `action` (`pick|read|authorize|current|list|switch|search|compare|close|closeAll`), `path?`, `paths?`, `ids?`, `id?`, `name?`, `query?`, `offset?`, `maxChars?`, `maxMatches?` |
| `projectControl` | VS Code project plan/apply/edit | `action` (`detect|reference|plan|apply|edit`), `root?`, `path?`, `request?`, `structure?`, `planId?`, `content?`, `confirmOverwrite?` |
| `appControl` | Allowlisted Windows app control | `action`, `app?`, `approvalId?`, `url?`, `query?`, `folder?` |
| `taskControl` | Multi-step desktop task | `action` (`plan|run|status|cancel`), `steps?` (max 8), `planId?`, `confirmDestructive?` |

`appControl` and `taskControl` operate on a fixed app allowlist. `close` requires
a second call with the `approvalId`; destructive task plans require
`confirmDestructive:true` after an explicit user yes. `projectControl` requires
a plan and user confirmation before `apply`; `edit` is a write action and must be
confirmed by the product's voice policy.

Tool failures are normal result objects, not transport errors. The model is
instructed never to claim success without a success result.

### 6.1 Completion receipt

Main-executed tools deliver results as:

```json
{
  "v": 1,
  "kind": "completion",
  "callId": "...",
  "toolName": "fileControl",
  "sessionId": "...",
  "argsDigest": "<sha256>",
  "executionStatus": "success | execution_error | denied | cancelled",
  "result": { "...": "tool output" },
  "resultDigest": "<sha256 or null>",
  "reason": "optional",
  "nonce": "<32 hex>",
  "issuedAtMs": 1763900000000,
  "sig": "<HMAC hex>"
}
```

The server verifies HMAC, session routing, registry, tool/args binding,
monotonic expiry, terminal/single-use state, main-executed status, and result
digest before forwarding to Gemini. `issuedAtMs` is informational only.

### 6.2 Renderer execution request

```js
await window.myraDesktop.executeTool({
  ticket: "<opaque ticket>",
  name: "fileControl",
  args: { action: "read", path: "C:\\notes.txt" }
});
```

Possible outcomes: `{status:"ok", result}`,
`{status:"error", reason}`, or `{status:"denied", reason}`. See
[errors.md](./errors.md) for all denial reasons.

## 7. Electron IPC contracts

```ts
window.myraDesktop = {
  isDesktop: true,
  platform: string,
  appVersion: string,
  runtime: { electron: string, chrome: string, node: string },
  wsAuthToken: string | null,
  executeTool(payload: { ticket: string; name: string; args?: object }):
    Promise<{ status: "ok" | "error" | "denied"; result?: unknown; reason?: string }>,
  taskStatus: {
    get(): Promise<TaskState>,
    onState(cb: (state: TaskState) => void): () => void
  },
  projectFolder: {
    pick(): Promise<{ canceled: boolean; root?: string; error?: string }>
  },
  fileAccess: {
    pick(): Promise<FileContextState>,
    state(): Promise<FileContextState>,
    close(): Promise<FileContextState>,
    onState(cb: (state: FileContextState) => void): () => void
  }
}
```

The main process treats every `executeTool` payload as untrusted, including the
ticket string. A malformed payload is answered without throwing:
`{status:"denied", reason:"malformed"}`.

## 8. Compatibility notes

- Adding a new server → client frame type is backward compatible for the
  existing renderer (unknown frames are ignored by `App.tsx`). Changing the
  meaning of an existing frame is a breaking change.
- The phone ignores unknown snapshot fields; adding fields is safe. Removing or
  renaming one is breaking.
- Tool schemas are sent to Gemini on every session. Renaming an action is
  breaking for both the model and the executor allowlist.
- Ticket and receipt field names/signatures are security-critical; any change
  must be mirrored in `src/server/handoff.ts`,
  `electron/lib/handoffAuthority.cjs`, and `electron/lib/ipcValidate.cjs`.
- Persisted JSON is read without a migration layer. A schema change must either
  keep old files readable or add an explicit migration.

## 9. Contract findings

1. **Malformed intelligence JSON has no JSON error envelope.** The intelligence
   router does not install a JSON body-parser error handler. Express's default
   handler returns HTML for malformed JSON (`400`) and oversized bodies (`413`),
   unlike the documented `{ok:false,error,...}` shape. Remote routes do have a
   handler and return `{ok:false,error:"badRequest"}`.
2. **`/ws` has no application-level heartbeat.** Dead connections are detected by
   the TCP/WebSocket layer only. `/remote/ws` has a 25 s ping/pong heartbeat.
3. **No request ID/correlation header.** HTTP errors cannot be correlated to a
   specific server log line except by timestamp.
4. **`/api/health` reveals provider and auth mode unauthenticated.** This is
   low-risk on loopback but is information disclosure if `HOST` is changed.
5. **`/ws` accepts any Origin.** It relies on the bearer token rather than an
   Origin allowlist; see `docs/SECURITY.md`.
