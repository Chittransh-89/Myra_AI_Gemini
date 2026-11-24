# Myra Remote Control — Phase 1 + Phase 2

Phase 1 adds a secure phone dashboard for Myra. It provides:

- a remote dashboard at `/remote`
- one-time-code pairing between the desktop and one phone
- an authenticated phone WebSocket at `/remote/ws`
- a read-only Myra / PC / microphone state snapshot
- connection status and basic reconnect handling
- Tailscale Serve as the only supported network exposure

Phase 2 adds **phone microphone streaming**: the phone captures its microphone,
resamples to mono 16 kHz PCM16 little-endian, and streams bounded chunks over
the already-authenticated `/remote/ws` socket. The server validates every frame
and forwards it into the **existing** desktop Gemini Live session.

Phase 2 does **not** add Myra ON/OFF lifecycle control (Phase 3) or voice-OFF
detection. The phone UI says so explicitly. Phase 2 never creates a Gemini
session of its own: if no desktop session is attached, phone audio is rejected
with `sessionUnavailable` and nothing is buffered.

## Security model

| Item | Behaviour |
| --- | --- |
| Desktop authentication | Existing per-run `MYRA_WS_TOKEN`, sent as `x-myra-desktop-token` |
| Pairing code | 6 digits, one-time use, 5-minute lifetime, shown only in the desktop app |
| Phone token | 256-bit random value; only its SHA-256 hash is kept in memory |
| Phone cookie | `myra_remote`, `HttpOnly`, `SameSite=Strict`, `Path=/remote` |
| Transport | HTTPS/WSS only in real use (Tailscale Serve terminates TLS) |
| Sessions | Exactly one phone session; pairing another phone revokes the old token |
| Audio origin | Phone frames are accepted only on the paired cookie; never via URL/query token |
| Audio format | Base64 PCM16 little-endian, even length, mono 16 kHz, ≤ 8 KB decoded per frame |
| Audio rate | Token bucket (64 KB/s sustained, 48 KB burst); excess is dropped, never queued |
| Phone authority | The phone cannot call tools or submit tool responses — those frames get `forbidden` |
| Persistence | None. A server restart invalidates every pairing and code |
| Rate limit | 5 pairing attempts per client per minute |
| Rate-limit identity | Socket peer by default; `X-Forwarded-For` only with `MYRA_TRUST_PROXY=1` (see below) |
| Secret logging | Desktop WS token, handoff nonce and receipt key are never logged; the renderer logs the `/ws` path without its query string |
| Direct entry file | `/remote.html` is never served; the dashboard is reachable only at `/remote` |
| Pairing API caching | `Cache-Control: no-store` + `Pragma: no-cache` on both desktop pairing endpoints |
| Exposure | Tailscale tailnet only — no public unauthenticated endpoint |

The desktop token is never sent to the phone. The phone only ever holds its own
pairing token, inside an `HttpOnly` cookie that JavaScript cannot read. The
Gemini API key never leaves the desktop server process.

## Enable remote control

Remote control is enabled automatically when Myra runs under Electron with a
per-run WS token. Standalone website runs keep the original behaviour and
return `404 remoteDisabled` for `/remote`.

Optional environment variables (see `.env.example`):

```dotenv
# Strict boolean: 1/0, true/false, yes/no, on/off.
# Unset = enabled (Electron only). An invalid value fails CLOSED (disabled).
MYRA_REMOTE=1

# Trust one local reverse proxy (Tailscale Serve) for pairing rate limiting.
# Default 0. Enable only when Serve is the sole ingress.
MYRA_TRUST_PROXY=1

# Public HTTPS URL shown to the phone and accepted as a WebSocket Origin
MYRA_REMOTE_PUBLIC_URL=https://myra-pc.example-tailnet.ts.net
```

`MYRA_REMOTE_PUBLIC_URL` should be the Tailscale Serve origin. If you provide
only an origin, Myra appends `/remote` for the URL shown in the desktop panel.

### Strict flag parsing

`MYRA_REMOTE` and `MYRA_TRUST_PROXY` accept only `1/0`, `true/false`,
`yes/no`, `on/off` (case-insensitive, surrounding spaces ignored). Any other
value produces a startup warning naming the variable and falls back to the
**safe default** — disabled. A typo such as `MYRA_REMOTE=ture` therefore cannot
silently expose the remote surface. The warning never contains a secret.

## Rate limiting behind Tailscale Serve

Pairing attempts are limited per client key. Without configuration the key is
the TCP peer address, which is what Myra sees directly. When the phone reaches
Myra through Tailscale Serve, **every** request arrives from `127.0.0.1`, so all
phones share one bucket and a burst of failures from any client throttles the
legitimate one.

Set `MYRA_TRUST_PROXY=1` in that topology. Myra then uses
`X-Forwarded-For`, but only under strict conditions:

- the direct peer must be loopback (a remote client cannot inject the header);
- only the **right-most valid IP** in the chain is used — the address the
trusted proxy itself observed — so a client cannot prepend a fake address to
escape its bucket;
- malformed or empty headers fall back to the peer address.

Leave `MYRA_TRUST_PROXY` unset when the server port is reachable directly: a
header supplied by the client is never trusted in that case.

## Tailscale Serve setup

Tailscale Serve publishes a local port to your tailnet over HTTPS. It does not
expose the port to the public internet.

1. Install Tailscale on the Myra PC and sign in.
2. Enable **MagicDNS** and **HTTPS certificates** for your tailnet in the
   Tailscale admin console.
3. Start Myra so the local server is listening on `127.0.0.1:3000` (or `PORT`).
4. Serve the local Myra port over HTTPS:

   ```powershell
   tailscale serve --bg 3000
   ```

   Newer CLI versions also accept the explicit form:

   ```powershell
   tailscale serve --bg --https=443 http://127.0.0.1:3000
   ```

5. Read the assigned URL:

   ```powershell
   tailscale serve status
   ```

   It looks like `https://myra-pc.<your-tailnet>.ts.net`.

6. Put that origin in `MYRA_REMOTE_PUBLIC_URL`, restart Myra, and open
   `https://myra-pc.<your-tailnet>.ts.net/remote` on the phone.

Useful commands:

```powershell
tailscale serve status   # show what is being served
tailscale serve reset    # remove all serve mappings
```

Notes:

- Keep the Myra server bound to loopback. Tailscale Serve is the only ingress.
- Do not use Funnel (`tailscale funnel`) for v1. Funnel is public internet
  exposure and is out of scope.
- Tailscale is not installed on this development PC, so the commands above
  could not be executed here. They are the documented v1 path.

## Pairing a phone

1. Start Myra on the PC.
2. The desktop shows the **Phone Remote** panel with a 6-digit code, its expiry
   countdown, the paired device, and the phone URL.
3. On the phone, open the remote URL and enter the code.
4. The phone receives its own token cookie and connects to `/remote/ws`.
5. The desktop panel updates to show the paired device.

Click **New code** on the desktop to rotate the code immediately. A code is
consumed after a successful pairing; a new code is generated automatically for
the next pairing.

To revoke access, click **Unpair** in the phone UI, pair a different phone
(which revokes the previous token), or restart the Myra server.

## Desktop behaviour in Electron mode

The desktop activation button does **not** start a local Gemini session in
Electron mode. It reveals the phone pairing / connection panel instead. This
keeps the phone as the single remote controller and avoids a second,
unmanaged microphone path.

The existing desktop microphone and local voice mode remain unchanged for
standalone (non-Electron) runs.

## Phase 2: phone microphone audio

### Capture (phone)

`src/remote/audioCapture.ts` requests the microphone only from the **Start mic**
button (a user gesture, required by mobile browsers). It prefers a native
16 kHz `AudioContext`; if the browser refuses that rate it uses the hardware
rate and resamples with a linear-interpolation downsampler
(`src/remote/pcm.ts`). Output is fixed-size **100 ms** chunks:

| Property | Value |
| --- | --- |
| Sample rate | 16 000 Hz |
| Channels | 1 (mono) |
| Encoding | signed PCM16, little-endian, base64 in JSON |
| Chunk | 1 600 samples = 3 200 bytes = 100 ms |
| Uplink | `/remote/ws`, cookie-authenticated |
| Downlink | none (Myra's voice is not returned to the phone in Phase 2) |

### Wire protocol

Phone → server:

```json
{ "type": "audioStart" }
{ "type": "audio", "data": "<base64 PCM16>", "seq": 42 }
{ "type": "audioStop" }
```

Server → phone:

```json
{ "type": "audioAck", "seq": 42, "bytes": 3200 }
{ "type": "remoteState", "snapshot": { "mic": { "streaming": true } } }
{ "type": "error", "code": "sessionUnavailable", "message": "..." }
```

### Manual Phone Remote lifecycle

Phone Remote is **OFF by default and manual-only**. Nothing enables it except
an explicit `audioStart` from the user pressing **Phone Remote ON** on that
socket:

- A new or reconnected phone socket always starts with `mic.enabled: false`.
- `audio` frames received while it is OFF are rejected with `micNotEnabled`
  and never reach the sink, so late/queued frames cannot leak into a session.
- Connect Voice (desktop `/ws`) starting, stopping or reconnecting never sends
  `audioStart` and never changes the phone's manual state.
- `audioStop`, socket close, replacement and unpair all set `mic.enabled` and
  `mic.streaming` to false.

### Server-side validation

Every frame is checked **before** it can reach Gemini:

- `data` must be a non-empty string, strict base64 (no whitespace/URL-safe
alphabet), length a multiple of 4, decoded length even and non-zero.
- Decoded size is capped at **8 KB** per chunk; the whole JSON frame is capped
  at 64 KB by the WebSocket server (`maxPayload`).
- Oversized frames get `audioTooLarge` and the socket closes with `1009`.
- Malformed frames get `badAudio` and are dropped; they never reach the sink.
- Accepted byte rate is bounded by a token bucket (64 KB/s sustained, 48 KB
  burst). Excess audio gets `audioRateLimited` and is **dropped, not queued**.
- `toolResponse`, `toolCall` and `tool` frames are rejected with `forbidden`.

### Integration boundary

`RemoteAudioBridge` (`src/server/remote/audioBridge.ts`) holds the sink of the
**already established** desktop Gemini session and forwards each accepted
chunk with `session.sendAudio(base64)`. It never constructs a provider, never
opens a WebSocket to Gemini, and never retries. If no desktop session is
attached, `push()` returns `noSession` and the phone receives
`sessionUnavailable` at most once every 2 seconds.

When several desktop sessions exist, the newest attached session is active and
detaching it falls back to the previous one. A session detaches when its `/ws`
provider closes.

### Cleanup and interruptions

- Phone socket close/replacement, server-side revocation, React unmount, and
  **Unpair** all call `PhoneAudioCapture.stop()`, which clears
  `onaudioprocess`, disconnects source/processor/sink nodes, stops every
  `MediaStreamTrack`, closes the `AudioContext`, and resets the chunk buffer.
  `unpair()` stops capture locally before the request, so a hidden dashboard
  can never leave a live microphone behind.
- The phone drops a chunk when `WebSocket.bufferedAmount` exceeds 256 KB or the
  socket is not `OPEN`; it reports `sent`/`dropped` counters instead of growing
  an unbounded send buffer.
- The server keeps no audio queue. A 2-second idle watchdog flips
  `mic.streaming` back to `false` if frames stop arriving.

## What Phase 2 does not do

- No Myra session ON/OFF control. `control` frames receive
  `{"type":"error","code":"notImplemented"}`. Only the phone microphone has
  a manual ON/OFF (`audioStart` / `audioStop`).
- No managed Myra lifecycle. `myra.state` reports `ACTIVE` only when an
  existing legacy desktop Gemini session is established; otherwise `INACTIVE`.
  Phone audio therefore requires the desktop to have an active session.
- No voice-OFF detection, no 10-second reconnect grace period, and no
  phone-mic → desktop-mic handover; those land with Phase 3.
- No assistant audio playback on the phone (uplink only).
- No persistence: restarting the server requires pairing again.

## Phase 3 integration contract

Phase 3 must connect exactly these points; Phase 2 deliberately stops short of
them:

1. **Start the session.** Something must call the existing provider
   `createSession(...)` for the managed lifecycle (phone ON, or PC wake) so that
   `remoteAudioBridge.attach(sessionId, sink)` has a live session to attach.
   Phase 2 only attaches to sessions created by a desktop `/ws` client.
2. **Own the session id.** Keep one session id for the managed lifecycle and
   reuse it for `runtime.markSessionEstablished` / `clearSessionEstablished`,
   so `myra.state` reflects the managed session rather than a legacy client.
3. **Report failures.** Set `runtime.setError(...)` when the managed session
   cannot start; the phone already renders `snapshot.error`.
4. **Define stop semantics.** On phone OFF / kill switch, detach the bridge
   (`remoteAudioBridge.detach(sessionId)`) before closing the provider session,
   then set `mic.streaming` false.
5. **Decide the mic handover.** If both desktop and phone microphones may be
   active, Phase 3 must arbitrate; Phase 2 has no priority logic.
6. **Optionally add assistant audio downlink.** Phase 2 sends no model audio to
   the phone; playback would be a new frame type with its own bounds.

## Reconnect behaviour

The phone socket uses a 20-second application heartbeat plus WebSocket
ping/pong. If the link drops, the phone retries with exponential backoff
(1s, 2s, 4s, 8s, capped at 15s) and retries immediately when the page becomes
visible again. Reconnecting restores only the control channel: Phone Remote
stays OFF and must be pressed again. A revoked session closes with code `4003`;
a replaced session closes with `4001`. Both are surfaced in the UI.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/remote` | none | Phone dashboard shell |
| POST | `/remote/pair` | pairing code | Exchange code for phone token cookie |
| POST | `/remote/unpair` | phone cookie | Revoke this phone session |
| GET | `/remote/api/state` | phone cookie | Status snapshot |
| GET | `/api/remote/pairing` | desktop token | Code, expiry, paired device, phone URL |
| POST | `/api/remote/pairing/rotate` | desktop token | Generate a new code |
| GET | `/remote.html` | none | Always `404` — the built entry file is not served |
| WS | `/remote/ws` | phone cookie | Status stream, phone audio (`audio`), `audioStop` |

Both desktop pairing endpoints are `Cache-Control: no-store`, so a code or URL
never lands in a browser, proxy or disk cache.

## Troubleshooting

- **404 `remoteDisabled`** — Myra is not running in Electron mode, has no
  per-run token, or `MYRA_REMOTE=0`.
- **Phone cannot connect** — check `tailscale serve status`, confirm the URL is
  the Serve origin, and make sure `MYRA_REMOTE_PUBLIC_URL` matches it.
- **Code rejected** — codes expire after 5 minutes and work once. Rotate a new
  code on the desktop.
- **Too many attempts** — wait one minute; the rate limiter resets per client.
- **One phone's failures lock out another** — the clients are sharing the
  loopback identity. Set `MYRA_TRUST_PROXY=1` when Serve is the only ingress.
- **Remote disabled after changing `MYRA_REMOTE`** — the value was not a
  recognised boolean. Check the startup warning and use `1/0` etc.
- **`/remote.html` returns 404** — intentional. Open `/remote` instead.
- **Pairing lost after restart** — expected. Pairing is in-memory only.
- **`sessionUnavailable` while the mic is streaming** — the phone transport is
  healthy but no desktop Gemini session is attached. Start Myra locally (or
  wait for Phase 3's managed lifecycle). Audio is not queued.
- **`audioRateLimited`** — the phone is sending faster than real time or the
  chunk size is wrong; the client sends 100 ms chunks and drops on backpressure.
- **`badAudio` / `audioTooLarge`** — a non-PCM16, odd-length, malformed base64
  or oversized payload was rejected; nothing reached Gemini.
- **Microphone prompt never appears** — mobile browsers require HTTPS and a user
  gesture. Open the Tailscale Serve URL and tap **Start mic**.
