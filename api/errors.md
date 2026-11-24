# Myra AI — Error Reference

> Generated from the implementation on 2026-11-23. Codes are stable strings
> consumed by the UI; HTTP status codes are the second contract.

## 1. Error envelope

### HTTP

Intelligence and remote routes use:

```json
{ "ok": false, "error": "someCode", "message": "Human-readable explanation." }
```

`message` is present on intelligence routes. Most remote route errors contain
only `ok` and `error`; malformed remote JSON bodies use `badRequest`.

`/api/health` has no error envelope because it has no failure response in normal
operation. `/remote` returns an HTML fallback, not JSON, if the dashboard file
cannot be read.

### WebSocket `/ws`

```json
{ "type": "status", "state": "error", "message": "Authentication failed." }
```

or:

```json
{ "type": "error", "message": "AI provider error: ..." }
```

### WebSocket `/remote/ws`

```json
{ "type": "error", "code": "badMessage", "message": "Invalid JSON." }
```

### Electron tool execution

```json
{ "status": "denied", "reason": "forged" }
```

or:

```json
{ "status": "error", "reason": "executorError" }
```

## 2. HTTP status map

| Status | Meaning in this project |
| --- | --- |
| `200` | Success |
| `400` | Bad input, malformed JSON, invalid/expired pairing code, invalid interview type/difficulty/ID, answer too long, unsafe path |
| `401` | Missing/wrong desktop token or phone cookie |
| `403` | Loopback-only violation, foreign Origin, unapproved folder, kill-switch/authority denial at a higher layer |
| `404` | Missing route, disabled feature, unknown project/interview/report, missing local folder |
| `409` | Interview ended/not active/no open question, in-memory project files lost |
| `413` | Express body limit exceeded (currently HTML on intelligence routes) |
| `415` | `/remote/pair` body is not `application/json` |
| `422` | No readable source files, empty repository |
| `429` | Pairing rate limit, GitHub import budget, GitHub API rate limit |
| `500` | Unexpected server error |
| `502` | GitHub/AI upstream failure or unusable upstream response |
| `503` | Intelligence model unavailable (no API key) |
| `504` | GitHub or AI timeout |

## 3. Phone remote HTTP codes

| Route | Status | Code | Cause / handling |
| --- | --- | --- | --- |
| `/remote/pair` | 415 | `jsonRequired` | Send `Content-Type: application/json` |
| `/remote/pair` | 403 | `originRejected` | Origin host must equal request host, configured public URL host, `127.0.0.1`, or `localhost` |
| `/remote/pair` | 400 | `invalidCode` | Wrong code, already-consumed code, or malformed input |
| `/remote/pair` | 400 | `expiredCode` | Code exceeded its 5-minute lifetime; a new code was generated |
| `/remote/pair` | 429 | `rateLimited` | More than 5 failures in 60 s for this client key; includes `retryAfterMs` |
| `/remote/pair` | 400 | `badRequest` | Malformed/oversized JSON body (8 KB limit) |
| `/remote/api/state` | 401 | `unauthorized` | Missing, expired, or revoked `myra_remote` cookie |
| `/remote/unpair` | 401 | `unauthorized` | Same as above |
| `/api/remote/pairing` | 401 | `unauthorized` | Missing/wrong `x-myra-desktop-token` or server has no desktop token |
| `/api/remote/pairing/rotate` | 401 | `unauthorized` | Same as above |
| `/remote` | 404 | `remoteDisabled` | Standalone/website mode; remote requires Electron + token |
| `/remote.html` | 404 | `remoteDisabled` or `notFound` | Direct entry file is always blocked |
| `/remote/ws` upgrade | 403 | `originRejected` | Origin not in the allowlist |
| `/remote/ws` upgrade | 401 | `unauthorized` | No valid phone cookie (query tokens are ignored) |

A pairing code is consumed on success. A failure records an attempt before the
code comparison; after 5 failures in the window, even the correct code is
rejected until the window expires. Successful pairing clears the client's
attempt bucket.

### Phone WebSocket error frames

| Code | Meaning | Recovery |
| --- | --- | --- |
| `badMessage` | Invalid JSON, missing `type`, or unsupported type | Send a valid frame |
| `badAudio` | Data is not a non-empty base64 string of even-length PCM16 LE | Resample/encode correctly |
| `audioTooLarge` | Decoded frame > 8 KB or base64/socket frame > 64 KB | Send ≤ 100 ms chunks |
| `sessionUnavailable` | No desktop `/ws` session is attached, or audio bridge absent | Start voice on the PC |
| `audioRateLimited` | Token bucket exhausted (> 64 KB/s sustained / 48 KB burst) | Slow down; chunks are dropped, not queued |
| `audioRejected` | Provider send failed | Check desktop session/logs |
| `forbidden` | Phone sent a tool frame | The phone is audio-only |
| `notImplemented` | Phone sent `control` | ON/OFF control is not implemented |

Errors are throttled to one every 2 s per socket. Closing code `1009` follows an
`audioTooLarge` frame; `4001 replaced` and `4003 sessionRevoked` are lifecycle
events, not errors the phone should retry blindly.

## 4. Project Intelligence error codes

All of these use `{ok:false,error,message}`. Status values come from
`IntelligenceError` or the route middleware.

### Access / lifecycle

| Code | Status | Cause |
| --- | --- | --- |
| `unauthorized` | 401 | Electron mode, missing/wrong desktop token |
| `localOnly` | 403 | Standalone request from a non-loopback peer |
| `originRejected` | 403 | `Origin` present and not same-host |
| `internalError` | 500 | Unexpected exception; details are logged, not returned |
| `intelligenceDisabled` | 404 | `MYRA_INTELLIGENCE=0`; route is not mounted |
| `invalidId` | 400 | ID fails `proj_`/`itv_`/`rep_` validation |

### Imports — local

| Code | Status | Cause |
| --- | --- | --- |
| `invalidRoot` | 400 | Path rejected; message names the inner reason (`emptyPath`, `pathTooLong`, `badPath`, `unsupportedPath`, `pathNotAbsolute`, `rootTooBroad`) |
| `notADirectory` | 400 | Path exists but is not a directory |
| `folderNotFound` | 404 | Path cannot be opened |
| `folderNotApproved` | 403 | Electron mode and the root is not in the native-picker allowlist |
| `noReadableFiles` | 422 | All files filtered out |
| `projectFilesUnavailable` | 409 | In-memory import expired (30 min) or app restarted; import again |

### Imports — GitHub

| Code | Status | Cause |
| --- | --- | --- |
| `invalidGitHubUrl` | 400 | Not a usable public GitHub repository URL |
| `repositoryNotFound` | 404 | GitHub returned 404 |
| `privateUnsupported` | 400 | Repository is private |
| `emptyRepository` | 422 | No files in the tree |
| `noReadableFiles` | 422 | All files filtered out |
| `requestBudgetExceeded` | 429 | More than 220 requests in one import |
| `githubTimeout` | 504 | 15 s request timeout |
| `githubUnreachable` | 502 | Network/DNS failure |
| `githubError` | 502 (or upstream status) | Unreadable JSON/tree or other GitHub failure |
| `rateLimited` | 403 or 429 | GitHub returned 403/429; message includes the GitHub status/snippet |

### Analysis / model

| Code | Status | Cause |
| --- | --- | --- |
| `aiUnavailable` | 503 or 502 | No `GEMINI_API_KEY` (503) or the model request failed (502) |
| `aiTimeout` | 504 | 90 s text-generation timeout |
| `emptyModelResponse` | 502 | Model returned empty text |
| `invalidModelJson` | 502 | Model text was not parseable JSON |
| `projectNotFound` | 404 | No saved knowledge profile for that project |
| `questionGenerationFailed` | 502 | No opening question could be generated |

### Interviews

| Code | Status | Cause |
| --- | --- | --- |
| `interviewNotFound` | 404 | Unknown interview ID |
| `interviewEnded` | 409 | Pause/resume on an ended interview |
| `interviewNotActive` | 409 | Answer while paused or ended |
| `noQuestion` | 409 | Hint/explain/answer with no open question |
| `emptyAnswer` | 400 | Answer is empty/whitespace |
| `answerTooLong` | 400 | Answer > 8000 characters |
| `invalidInterviewType` | 400 | Not one of the six supported types |
| `invalidDifficulty` | 400 | Not `easy`, `medium`, `hard`, or `brutal` |
| `reportNotFound` | 404 | Unknown report ID |

### Parser behaviour finding

The intelligence router installs `express.json({limit:"512kb",strict:true})` per
POST but no error-handling middleware. Malformed JSON therefore reaches
Express's default handler, which returns an HTML `400`; an oversized body
returns an HTML `413`. The remote router has its own handler and returns
`{ok:false,error:"badRequest"}`. Clients must not assume the JSON envelope for
these two cases.

## 5. `/ws` errors

| Situation | Wire behaviour | Notes |
| --- | --- | --- |
| Missing/wrong token | `status/error` "Authentication failed." then close | No application close code (typically `1005`) |
| Provider setup failure | `error` frame with `AI provider error: ...` | `LocalProvider` returns an explicit "not implemented" error |
| Provider closes | `status/disconnected` with `reason` | Reconnect by creating a new socket |
| Provider runtime error | `error` frame | May be followed by close/disconnect |
| Malformed JSON | No client response | Server logs "Error processing client message" |
| Unknown frame type | No client response | Silently ignored |
| Audio with no session | No client response | `ctx.session?.sendAudio` is a no-op |
| Tool response for unregistered/terminal/main tool | Dropped | Server logs a `[tamper]` marker |
| All tool responses dropped | No client response | Fail-closed |

There is no error code field on `/ws` error frames; only `message`. Do not parse
the message for control flow.

## 6. Handoff Authority errors

### Registration (`registerPendingCall`)

| Reason | Meaning |
| --- | --- |
| `killSwitchActive` | Kill switch is engaged; registration blocked |
| `malformedCallId` | Call ID fails the safe-ID pattern |
| `unknownToolName` | Tool not in the static executor allowlist or executor not wired |
| `malformedSessionId` | Session ID fails validation |
| `duplicateCallId` | A registration already exists for this call |
| `channelSaturated` | 64 pending registrations on this channel/pipe |
| `malformedArgs` | Args are not strict canonical JSON / too large |
| `internalError` | Canonicalisation or unexpected failure |

The server maps registration failures to the tool call's `handoff.error` and,
for main-executed tools, immediately sends Gemini a synthesized
`{error: reason}` result. The renderer must not be expected to close those calls.

The server can also emit `handoffUnavailable` (pipe never connected/currently
down) or `handoffError` (client call threw). `duplicateCallId` is preserved as a
terminal server-side condition.

### Ticket execution denials

| Reason | Meaning |
| --- | --- |
| `malformed` | Payload/ticket shape/size invalid |
| `forged` | HMAC does not verify |
| `nameMismatch` | Request tool name differs from the signed ticket |
| `killSwitchActive` | Kill switch engaged before execution |
| `replay` | Registration no longer pending / ticket already consumed |
| `registryMismatch` | Call ID/name/digest/session/expiry does not match registry |
| `expired` | Monotonic deadline passed |
| `malformedArgs` | Args cannot be canonically digested |
| `argsTampered` | Args digest differs from ticket |
| `executorUnavailable` | No executor is wired for this tool |
| `executorError` | Executor threw or returned an unusable result |
| `internalError` | Unexpected authority failure |

Every denial is audited (`TICKET_DENIED`, `EXECUTE_DENIED`,
`EXECUTE_BLOCKED`, or `EXECUTE_ERROR`) with whitelisted metadata only.

### Completion statuses

`success` and `execution_error` carry a `result` plus `resultDigest`; `denied`
and `cancelled` carry no result requirement. The server converts any non-success
into `{error:"toolExecutionFailed", detail: reason ?? status}` before forwarding.
Server-side rejection markers include `COMPLETION_MALFORMED`,
`COMPLETION_UNKNOWN_SESSION`, `COMPLETION_UNREGISTERED`,
`COMPLETION_BINDING_MISMATCH`, `COMPLETION_EXPIRED`, `COMPLETION_TERMINAL`,
`COMPLETION_NOT_MAIN_EXECUTED`, and `COMPLETION_DIGEST_MISMATCH`.

## 7. Startup and infrastructure errors

| Message | Source | Meaning |
| --- | --- | --- |
| `AI_PROVIDER=gemini requires GEMINI_API_KEY ...` | provider factory | Server refuses to start without a key when Gemini is selected |
| `Provider "gemini" reports itself as unavailable...` | provider factory | Availability check failed |
| `Server did not become healthy in time` | Electron `waitForServer` | `/api/health` did not return 200 within 45 s |
| `Failed to start the Myra server: ...` | Electron dialog | Startup failed; app exits 1 |
| `EADDRINUSE` (Node) | server listen | Port already in use |
| `Local AI is not yet implemented...` | `LocalProvider` | `AI_PROVIDER=local`; intentional stub |

## 8. Diagnosing errors safely

- Server logs are on stdout/stderr in development; Electron prefixes them with
  `[server]` / `[server:err]`.
- Security audit events are in `<userData>/logs/audit-YYYY-MM-DD.jsonl`, one JSON
  object per line. They never contain args, paths, file contents, or tokens.
- Never paste `.env`, `MYRA_WS_TOKEN`, the handoff nonce, receipt key, pairing
  cookie, or full authenticated `/ws` URL into an issue report.
- The `message` on `aiUnavailable`/`githubError` may contain a truncated upstream
  detail; treat it as diagnostic, not stable API.
