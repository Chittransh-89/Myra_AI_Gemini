# Myra AI — Endpoint Inventory

> **Status:** generated from the implementation on 2026-11-23.
> **Source of truth:** this `api/` folder documents what the code actually exposes.
> Route code: `src/server/index.ts`, `src/server/remote/routes.ts`,
> `src/server/intelligence/routes.ts`, `electron/preload.cjs`, `electron/main.cjs`.

## Runtime surfaces

| Surface | Default address | Notes |
| --- | --- | --- |
| Desktop/website HTTP | `http://127.0.0.1:3000` | `HOST`/`PORT` override; loopback is the default |
| Desktop voice WebSocket | `ws://127.0.0.1:3000/ws` | Gemini Live audio + tool calls |
| Phone dashboard | `http://127.0.0.1:3000/remote` | Electron-only feature |
| Phone WebSocket | `ws://127.0.0.1:3000/remote/ws` | Cookie-authenticated audio input |
| Electron IPC | renderer ↔ main | Narrow bridge, not HTTP |

The API is **not versioned** with a URL prefix. WebSocket handoff tickets and
completion receipts carry `v: 1`; persisted intelligence documents carry
`version: 1`.

## Authentication summary

| Credential | Where it is used | How it is sent |
| --- | --- | --- |
| Per-run desktop token (`MYRA_WS_TOKEN`) | `/ws`, `/api/remote/pairing*`, `/api/intelligence/*` in Electron | `?auth=` query on `/ws`; `x-myra-desktop-token` header on HTTP |
| Phone pairing token | `/remote/api/state`, `/remote/unpair`, `/remote/ws` | `myra_remote` HttpOnly cookie; `Authorization: Bearer` also accepted by `phoneToken()` for HTTP routes |
| Kill switch | main process only | tray / `Ctrl+Alt+Shift+Space` / `Ctrl+Alt+Shift+K` |
| Handoff ticket | `window.myraDesktop.executeTool()` | opaque base64url string minted by Electron main |

`/api/health`, `/remote`, `/remote/pair`, and the static frontend are
unauthenticated. Everything that can read local source, pair a phone, or drive a
tool is authenticated or loopback-restricted.

## Public and lifecycle routes

| Method | Path | Auth | Success | Notes |
| --- | --- | --- | --- | --- |
| `GET` | `/api/health` | none | `200` `{status:"ok", mode, provider, wsAuth}` | Readiness probe used by Electron (`waitForServer`) |
| `GET` | `/` and SPA routes | none | `200` HTML | Vite middleware in development; `dist/index.html` in production |
| `GET` | `/remote`, `/remote/` | none | `200` HTML | Serves `remote.html`; dev mode runs it through Vite's HTML transform |
| `GET` | `/remote.html`, `/remote.html/*` | none | `404` JSON | Direct entry file is always blocked |
| `GET` | unknown non-API path (production) | none | `200` `index.html` | SPA fallback |

When remote is disabled (standalone/website mode), `/remote`, `/remote/*`, and
`/api/remote/*` return `404 {ok:false,error:"remoteDisabled"}`. When Project
Intelligence is disabled, `/api/intelligence*` returns
`404 {ok:false,error:"intelligenceDisabled"}`.

## Phone remote HTTP routes

| Method | Path | Auth | Request | Success response |
| --- | --- | --- | --- | --- |
| `POST` | `/remote/pair` | none; JSON body; Origin allowlist; 5 attempts/min/client | `{code, deviceName?}` | `200 {ok:true, deviceName, expiresAt, snapshot}` + `Set-Cookie: myra_remote=...; HttpOnly; SameSite=Strict; Path=/remote` |
| `GET` | `/remote/api/state` | phone cookie/Bearer | — | `200 {ok:true, snapshot}` |
| `POST` | `/remote/unpair` | phone cookie/Bearer | — | `200 {ok:true}` and clears the cookie |
| `GET` | `/api/remote/pairing` | desktop token | — | `200 {ok:true, enabled, code, expiresAt, pairedDevice, pairedAt, remoteUrl, serverTime}` |
| `POST` | `/api/remote/pairing/rotate` | desktop token | — | Same shape as `GET /api/remote/pairing`, with a new code |

`/remote/pair` rejects non-JSON with `415 jsonRequired`, rejects disallowed
origins with `403 originRejected`, and maps pairing failures to
`400 invalidCode`, `400 expiredCode`, or `429 rateLimited` (with `retryAfterMs`).

`/api/remote/pairing` and `/rotate` also act as a PC presence heartbeat
(`runtime.touchDesktop()`), so the phone can show the PC as connected. Both set
`Cache-Control: no-store` and `Pragma: no-cache`.

## Project Intelligence HTTP routes

All routes below are mounted under `/api/intelligence` and are protected by the
same middleware:

- **Electron mode:** require `x-myra-desktop-token` equal to the per-run token.
- **Standalone mode:** require a loopback socket peer. A present `Origin` header
  must match the request host.
- Always send `Cache-Control: no-store, max-age=0` and `Pragma: no-cache`.
- JSON bodies are limited to **512 KB**; only the POST routes parse a body.

| Method | Path | Request body / query | Success response (top-level keys) |
| --- | --- | --- | --- |
| `POST` | `/import/local` | `{path}` | `{ok, project: ImportedProjectView, aiAvailable}` |
| `POST` | `/import/github` | `{url}` | `{ok, project: ImportedProjectView, aiAvailable}` |
| `POST` | `/projects/:projectId/analyze` | — | `{ok, project: ProjectKnowledge}` |
| `GET` | `/projects` | — | `{ok, projects: ProjectSummary[]}` |
| `GET` | `/projects/:projectId` | — | `{ok, project: ProjectKnowledge, interviews: InterviewSummary[]}` |
| `POST` | `/interviews` | `{projectId, type, difficulty}` | `{ok, session: InterviewSession, question: InterviewQuestion}` |
| `GET` | `/interviews` | `?projectId=` optional | `{ok, interviews: InterviewSummary[]}` |
| `GET` | `/interviews/:id` | — | `{ok, session: InterviewSession, report: InterviewReport \| null}` |
| `POST` | `/interviews/:id/answer` | `{answer}` (≤ 8000 chars) | `{ok, session, assessment, nextQuestion, finished}` |
| `POST` | `/interviews/:id/hint` | — | `{ok, hints: string[]}` |
| `POST` | `/interviews/:id/explain` | — | `{ok, concept, explanation}` |
| `POST` | `/interviews/:id/skip` | — | `{ok, session, question}` |
| `GET` | `/interviews/:id/code` | — | `{ok, samples: CodeSnippet[]}` |
| `POST` | `/interviews/:id/pause` | — | `{ok, session}` |
| `POST` | `/interviews/:id/resume` | — | `{ok, session}` |
| `POST` | `/interviews/:id/end` | — | `{ok, session, report: InterviewReport}` |
| `POST` | `/interviews/:id/transcript` | `{role?, text?, source?}` | `{ok:true}` |
| `GET` | `/reports/:reportId` | — | `{ok, report: InterviewReport}` |

`type` is one of `overview`, `deep_dive`, `code`, `architecture`, `debugging`,
`full`. `difficulty` is one of `easy`, `medium`, `hard`, `brutal`.

`POST /interviews/:id/transcript` accepts `role: "candidate" | "interviewer"`
(anything else becomes `interviewer`), `source: "voice" | "text"` (anything else
becomes `text`), and silently ignores an empty/whitespace text. This endpoint is
best-effort and returns `ok` even when the interview does not exist or has ended.
The `/ws` voice pipeline normally records transcripts server-side; this endpoint
exists for the text panel.

The `analyze` endpoint returns an existing saved `ProjectKnowledge` when one is
already on disk, unless the project is still in the in-memory pending-import
map. In-memory imports expire after **30 minutes**; at most **4** are retained.

## WebSocket endpoints

| Path | Auth | Purpose |
| --- | --- | --- |
| `/ws` | `?auth=<MYRA_WS_TOKEN>` when Electron or `MYRA_WEBSITE_MODE=token`; no auth in legacy open website mode | Desktop voice session, tool calls, Interview Mode voice |
| `/remote/ws` | `myra_remote` cookie only; Origin allowlist | Phone PCM audio input plus read-only state |

`/ws` accepts an optional `interview=<itv_...>` query parameter. A valid,
non-ended interview appends an interviewer instruction to Myra's normal system
instruction and enables transcript recording. An invalid/ended interview falls
back to the normal assistant.

Unknown WebSocket paths are destroyed by the single upgrade dispatcher
(`src/server/index.ts`); `/remote/ws` upgrades are handled only when remote is
enabled and pairing is initialised.

## Electron IPC surface

The renderer gets exactly these bridges from `electron/preload.cjs`:

| Direction | Channel / member | Purpose |
| --- | --- | --- |
| sync IPC | `myra:auth:ws-token` | Read the per-run `/ws` token once |
| invoke | `myra:tool:execute` | Submit an untrusted execution request to the Handoff Authority |
| invoke | `myra:task:state:get` | Read-only desktop task status |
| event | `myra:task:state` | Main pushes task state updates |
| invoke | `myra:project-intel:pick` | Open the native folder picker; records an approved root |
| invoke | `myra:file:pick` | Open the native file picker |
| invoke | `myra:file:state:get` | Read file-context metadata |
| invoke | `myra:file:close` | Close the active file context |
| event | `myra:file:state` | Main pushes file-context state |

No Node, filesystem, child-process, or unrestricted `process` API is exposed to
the renderer. Every tool request is re-validated in the main process.

## Not exposed

- No `/api` endpoint starts, stops, or configures a Gemini session; the only
  voice entry point is the `/ws` connection.
- The phone cannot call tools, submit tool responses, or start/stop Myra.
- `/remote.html` is never served, even when remote is enabled.
- `/api/intelligence/*` is never reachable through the phone cookie or the
  phone WebSocket.
- There is no OpenAPI/Swagger document; this folder is the hand-maintained
  contract.

## Related documents

- [Contracts](./contracts.md) — payload shapes and WebSocket frames.
- [Errors](./errors.md) — every error code and remediation.
- [Remote Control](../docs/REMOTE_CONTROL.md) — operator setup for Tailscale and pairing.
- [Project Intelligence](../docs/PROJECT_INTELLIGENCE.md) — product-level feature guide.
