import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Lock,
  Mic,
  MicOff,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
  Square,
  Wifi,
  WifiOff,
  XCircle,
} from "lucide-react";
import { PhoneAudioCapture } from "./audioCapture";

interface RemoteSnapshot {
  serverTime: number;
  uptimeMs: number;
  remote: {
    enabled: boolean;
    publicUrl: string | null;
    phoneConnected: boolean;
    deviceName: string | null;
    connectedAt: number | null;
  };
  pc: {
    connected: boolean;
    lastSeenAt: number | null;
    clients: number;
  };
  myra: {
    state: "INACTIVE" | "ACTIVE" | "STOPPING";
    mode: "legacy";
    /** True while Myra's reply audio is playing on the PC. */
    speaking: boolean;
  };
  mic: {
    source: "phone";
    defaultSource: "phone";
    streaming: boolean;
  };
  error: string | null;
}

type Phase = "loading" | "pair" | "connected" | "reconnecting" | "error";
type MicPhase = "idle" | "starting" | "streaming" | "error";

/** Drop chunks rather than letting the browser send buffer grow without bound. */
const MAX_WS_BUFFER_BYTES = 256 * 1024;
const AUDIO_ERROR_CODES = new Set([
  "sessionUnavailable",
  "audioRateLimited",
  "audioRejected",
  "badAudio",
  "audioTooLarge",
]);

function defaultDeviceName(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || "";
  if (/android/i.test(platform) || /android/i.test(nav.userAgent)) return "Android phone";
  if (/iphone|ipad|ios/i.test(platform) || /iphone|ipad/i.test(nav.userAgent)) return "iPhone";
  return "Phone";
}

function formatCode(code: string | undefined): string {
  if (!code) return "——— ———";
  return code.replace(/^(\d{3})(\d{3})$/, "$1 $2");
}

function describeMicError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? "";
  const message = (err as { message?: string } | null)?.message ?? "";
  if (name === "NotAllowedError" || name === "SecurityError" || /denied|permission/i.test(message)) {
    return "Microphone permission was blocked. Allow the microphone for this site in Chrome settings, then press Start mic again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone was found on this phone.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "The microphone is busy in another app. Close it and press Start mic again.";
  }
  return message || "Could not start the phone microphone.";
}

function stateLabel(state: RemoteSnapshot["myra"]["state"]): string {
  if (state === "ACTIVE") return "MYRA ACTIVE";
  if (state === "STOPPING") return "STOPPING";
  return "MYRA OFF";
}

function stateClasses(state: RemoteSnapshot["myra"]["state"]): string {
  if (state === "ACTIVE") return "border-cyan-400/50 bg-cyan-500/10 text-cyan-200";
  if (state === "STOPPING") return "border-amber-400/50 bg-amber-500/10 text-amber-200";
  return "border-slate-500/40 bg-slate-800/50 text-slate-300";
}

export default function RemoteApp() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [snapshot, setSnapshot] = useState<RemoteSnapshot | null>(null);
  const [pairCode, setPairCode] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [micPhase, setMicPhase] = useState<MicPhase>("idle");
  const [micError, setMicError] = useState<string | null>(null);
  const [audioNotice, setAudioNotice] = useState<string | null>(null);
  const [audioStats, setAudioStats] = useState({ sent: 0, dropped: 0 });

  const snapshotRef = useRef<RemoteSnapshot | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const attemptRef = useRef(0);
  const phaseRef = useRef<Phase>("loading");
  const socketRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<PhoneAudioCapture | null>(null);
  const audioSeqRef = useRef(0);
  const audioStatsRef = useRef({ sent: 0, dropped: 0 });

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const applySnapshot = (next: RemoteSnapshot | null) => {
    snapshotRef.current = next;
    setSnapshot(next);
  };

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;

    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const clearHeartbeat = () => {
      if (heartbeatTimer !== null) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) return;
      const n = attemptRef.current;
      attemptRef.current = n + 1;
      setAttempt(n + 1);
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(n, 4)) + Math.floor(Math.random() * 400);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectRef.current();
      }, delay);
    };

    const connect = () => {
      if (disposed) return;
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return;
      }

      setPhase(snapshotRef.current ? "reconnecting" : "loading");

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/remote/ws`);
      socket = ws;

      ws.onopen = () => {
        if (disposed) {
          try {
            ws.close(1000, "pageClosing");
          } catch {
            /* ignore */
          }
          return;
        }
        socketRef.current = ws;
        attemptRef.current = 0;
        setAttempt(0);
        setLinkError(null);
        setPhase("connected");
        try {
          ws.send(JSON.stringify({ type: "requestState" }));
        } catch {
          /* close handler will retry */
        }
        clearHeartbeat();
        heartbeatTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
            } catch {
              /* ignore */
            }
          }
        }, 20_000);
      };

      ws.onmessage = (event) => {
        let message: any;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message?.type === "remoteState" && message.snapshot) {
          applySnapshot(message.snapshot as RemoteSnapshot);
          setPhase("connected");
          return;
        }
        if (message?.type === "error") {
          const code = String(message.code || "");
          if (AUDIO_ERROR_CODES.has(code)) {
            setAudioNotice(String(message.message || code));
            return;
          }
          setLinkError(String(message.message || message.code || "Remote error"));
          if (message.code === "unauthorized" || message.code === "sessionRevoked") {
            applySnapshot(null);
            setPhase("pair");
          }
        }
      };

      ws.onclose = (event) => {
        clearHeartbeat();
        if (socket === ws) socket = null;
        if (socketRef.current === ws) socketRef.current = null;
        // Phase 2: never leave the phone microphone or AudioContext running
        // after the authenticated transport goes away.
        captureRef.current?.stop();
        captureRef.current = null;
        setMicPhase("idle");
        if (disposed) return;

        if (event.code === 4003 || event.code === 1008) {
          applySnapshot(null);
          setPhase("pair");
          return;
        }
        if (event.code === 4001) {
          setLinkError("Another phone session replaced this one.");
          setPhase("error");
          return;
        }

        setPhase("reconnecting");
        scheduleReconnect();
      };

      ws.onerror = () => {
        /* onclose performs reconnect / state handling */
      };
    };

    connectRef.current = connect;

    const bootstrap = async () => {
      try {
        const res = await fetch("/remote/api/state", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (disposed) return;
        if (res.status === 401) {
          setPhase("pair");
          return;
        }
        if (!res.ok) throw new Error(`State request failed (${res.status})`);
        const data = await res.json();
        if (disposed) return;
        applySnapshot((data?.snapshot as RemoteSnapshot) ?? null);
        connect();
      } catch (err: any) {
        if (disposed) return;
        setLinkError(err?.message || "Could not reach the Myra PC.");
        setPhase("error");
      }
    };

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (phaseRef.current === "reconnecting" || phaseRef.current === "error") {
        clearReconnect();
        connectRef.current();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    void bootstrap();

    return () => {
      disposed = true;
      connectRef.current = () => {};
      clearReconnect();
      clearHeartbeat();
      document.removeEventListener("visibilitychange", onVisibility);
      captureRef.current?.stop();
      captureRef.current = null;
      socketRef.current = null;
      if (socket) {
        try {
          socket.close(1000, "pageClosing");
        } catch {
          /* ignore */
        }
        socket = null;
      }
    };
    // Intentionally once: all mutable connection state lives in this closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitPair = async (event: FormEvent) => {
    event.preventDefault();
    setPairError(null);
    const code = pairCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setPairError("Enter the 6-digit code shown in the Myra desktop app.");
      return;
    }

    setPairBusy(true);
    try {
      const res = await fetch("/remote/pair", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, deviceName: deviceName.trim() || "Phone" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        const reason = String(data?.error || "");
        if (reason === "rateLimited") {
          setPairError("Too many attempts. Wait a minute and try again.");
        } else if (reason === "expiredCode") {
          setPairError("That code expired. Ask Myra for a new code.");
        } else {
          setPairError("Incorrect code. Check the Myra desktop app and try again.");
        }
        return;
      }

      applySnapshot((data.snapshot as RemoteSnapshot) ?? null);
      setPhase("connected");
      setPairCode("");
      connectRef.current();
    } catch {
      setPairError("Could not reach the Myra PC. Check Tailscale and try again.");
    } finally {
      setPairBusy(false);
    }
  };

  const unpair = async () => {
    // Stop capture locally first: the pairing panel is about to replace the
    // dashboard, and we must never leave a live microphone behind a hidden UI
    // even if the server is unreachable.
    const capture = captureRef.current;
    captureRef.current = null;
    capture?.stop();
    setMicPhase("idle");
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "audioStop" }));
      } catch {
        /* socket is going away anyway */
      }
    }
    try {
      await fetch("/remote/unpair", { method: "POST", credentials: "same-origin" });
    } catch {
      /* the local UI still resets */
    }
    applySnapshot(null);
    setLinkError(null);
    setPhase("pair");
    setPairCode("");
  };

  const startMic = async () => {
    if (micPhase === "starting" || micPhase === "streaming") return;
    setMicError(null);
    setAudioNotice(null);
    audioStatsRef.current = { sent: 0, dropped: 0 };
    setAudioStats({ sent: 0, dropped: 0 });
    audioSeqRef.current = 0;
    setMicPhase("starting");

    const capture = new PhoneAudioCapture();
    captureRef.current = capture;
    try {
      await capture.start((chunk) => {
        const ws = socketRef.current;
        const stats = audioStatsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          stats.dropped += 1;
          return;
        }
        // Never upload while Myra is speaking: the phone mic would pick up the
        // PC speakers and interrupt her own reply.
        if (snapshotRef.current?.myra.speaking) {
          stats.dropped += 1;
          return;
        }
        // Bounded send: never let the browser buffer grow without limit.
        if (ws.bufferedAmount > MAX_WS_BUFFER_BYTES) {
          stats.dropped += 1;
          return;
        }
        try {
          ws.send(
            JSON.stringify({ type: "audio", data: chunk.base64, seq: ++audioSeqRef.current })
          );
          stats.sent += 1;
        } catch {
          stats.dropped += 1;
        }
        if ((stats.sent + stats.dropped) % 10 === 0) setAudioStats({ ...stats });
      });

      if (captureRef.current !== capture) {
        capture.stop();
        return;
      }
      setMicPhase("streaming");
      if (snapshotRef.current?.myra.state !== "ACTIVE") {
        setAudioNotice(
          "Mic is ready, but Myra has no active session yet. Press CONNECT VOICE on the PC (or leave the PC app running) and your phone audio will join that session."
        );
      }
    } catch (err: any) {
      capture.stop();
      captureRef.current = null;
      setMicPhase("error");
      setMicError(describeMicError(err));
    }
  };

  const stopMic = () => {
    const capture = captureRef.current;
    captureRef.current = null;
    capture?.stop();
    setMicPhase("idle");
    setAudioStats({ ...audioStatsRef.current });
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "audioStop" }));
      } catch {
        /* socket is going away anyway */
      }
    }
  };

  const myraState = snapshot?.myra.state ?? "INACTIVE";
  const linked = phase === "connected";
  const errorText = linkError || snapshot?.error || null;

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-100 radial-bg">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))]">
        <header className="flex items-center justify-between border-b border-white/5 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-cyan-500/30 bg-cyan-500/10">
              <Smartphone className="h-5 w-5 text-cyan-300" />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-[0.18em] text-white">MYRA</p>
              <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-slate-500">
                Remote control
              </p>
            </div>
          </div>
          <div
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider ${
              linked
                ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300"
                : phase === "reconnecting"
                  ? "border-amber-400/40 bg-amber-500/10 text-amber-300"
                  : "border-slate-600/50 bg-slate-800/50 text-slate-400"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                linked ? "bg-emerald-400" : phase === "reconnecting" ? "bg-amber-400 animate-pulse" : "bg-slate-500"
              }`}
            />
            {linked ? "Linked" : phase === "reconnecting" ? "Reconnecting" : "Offline"}
          </div>
        </header>

        <main className="flex flex-1 flex-col gap-4 pt-5">
          {phase === "loading" && (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-cyan-300" />
              <p className="text-sm text-slate-300">Checking secure session…</p>
            </div>
          )}

          {phase === "pair" && (
            <section className="glass-panel rounded-3xl border border-cyan-500/20 p-5 shadow-2xl">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-cyan-500/30 bg-cyan-500/10">
                  <Lock className="h-5 w-5 text-cyan-300" />
                </div>
                <div>
                  <h1 className="text-base font-semibold text-white">Pair this phone</h1>
                  <p className="text-xs text-slate-400">
                    Enter the one-time code shown in the Myra desktop app.
                  </p>
                </div>
              </div>

              <form onSubmit={submitPair} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500">
                    Pairing code
                  </span>
                  <input
                    value={pairCode}
                    onChange={(event) => setPairCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-4 text-center font-mono text-2xl tracking-[0.35em] text-cyan-200 outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-500/20"
                    aria-label="Six digit pairing code"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500">
                    This device
                  </span>
                  <input
                    value={deviceName}
                    onChange={(event) => setDeviceName(event.target.value.slice(0, 64))}
                    className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-slate-200 outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-500/20"
                    aria-label="Device name"
                  />
                </label>

                {pairError && (
                  <p className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                    {pairError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={pairBusy || pairCode.length !== 6}
                  className="mt-1 flex w-full items-center justify-center gap-2 rounded-2xl border border-cyan-400/40 bg-cyan-500/15 px-4 py-3.5 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-cyan-200 transition hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {pairBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  {pairBusy ? "Pairing…" : "Pair securely"}
                </button>
              </form>

              <p className="mt-4 text-center text-[10px] leading-relaxed text-slate-500">
                Codes expire after 5 minutes and work once. Myra never exposes this page to the
                public internet — use Tailscale.
              </p>
            </section>
          )}

          {phase !== "loading" && phase !== "pair" && (
            <>
              {phase === "reconnecting" && (
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-3">
                  <div className="flex items-center gap-2 text-xs text-amber-200">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Reconnecting… attempt {attempt}
                  </div>
                  <button
                    onClick={() => connectRef.current()}
                    className="rounded-lg border border-amber-400/30 px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-amber-200 hover:bg-amber-500/15"
                  >
                    Retry now
                  </button>
                </div>
              )}

              {errorText && (
                <div className="flex items-start gap-2 rounded-2xl border border-red-500/30 bg-red-950/40 px-4 py-3 text-xs text-red-200">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                  <span>{errorText}</span>
                </div>
              )}

              <section className="glass-panel rounded-3xl border border-white/10 p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-slate-500">
                      Myra status
                    </p>
                    <p className="mt-1 text-2xl font-semibold text-white">{stateLabel(myraState)}</p>
                  </div>
                  <div className={`rounded-2xl border px-4 py-3 text-center ${stateClasses(myraState)}`}>
                    <p className="font-mono text-[9px] uppercase tracking-wider opacity-80">Lifecycle</p>
                    <p className="mt-0.5 text-sm font-bold tracking-wider">{myraState}</p>
                  </div>
                </div>

                <div className="mt-5 rounded-2xl border border-white/5 bg-slate-950/40 p-4" aria-disabled="true">
                  <button
                    type="button"
                    disabled
                    className="flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-slate-600/40 bg-slate-800/50 px-4 py-3.5 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400"
                  >
                    <Lock className="h-4 w-4" />
                    {stateLabel(myraState)}
                  </button>
                  <p className="mt-3 text-center text-[10px] leading-relaxed text-slate-500">
                    Start or stop the voice session on the PC, then use the microphone below.
                    The phone never opens a second Gemini session and this page never starts
                    one on its own.
                  </p>
                </div>
              </section>

              <section className="glass-panel rounded-3xl border border-white/10 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-slate-500">
                      Phone microphone
                    </p>
                    <p className="mt-1 text-sm font-semibold text-white">
                      {micPhase === "streaming"
                        ? myraState === "ACTIVE" && snapshot?.myra.speaking
                          ? "Myra speaking · mic paused"
                          : "Streaming to Myra"
                        : micPhase === "starting"
                          ? "Requesting microphone…"
                          : micPhase === "error"
                            ? "Microphone error"
                            : "Microphone idle"}
                    </p>
                    <p className="mt-1 text-[10px] text-slate-500">
                      16 kHz mono PCM16 · 100 ms chunks · uplink pauses while Myra
                      speaks to prevent speaker echo
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={micPhase === "streaming" || micPhase === "starting" ? stopMic : startMic}
                    disabled={phase !== "connected"}
                    className={`flex shrink-0 items-center gap-2 rounded-2xl border px-4 py-3 font-mono text-[10px] font-bold uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-40 ${
                      micPhase === "streaming" || micPhase === "starting"
                        ? "border-red-400/40 bg-red-500/10 text-red-200 hover:bg-red-500/20"
                        : "border-cyan-400/40 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25"
                    }`}
                  >
                    {micPhase === "streaming" || micPhase === "starting" ? (
                      <Square className="h-3.5 w-3.5" />
                    ) : (
                      <Mic className="h-3.5 w-3.5" />
                    )}
                    {micPhase === "streaming" || micPhase === "starting" ? "Stop mic" : "Start mic"}
                  </button>
                </div>

                <div className="mt-3 flex items-center gap-3 font-mono text-[9px] uppercase tracking-wider text-slate-500">
                  <span>Sent {audioStats.sent}</span>
                  <span>Dropped {audioStats.dropped}</span>
                  <span className="ml-auto flex items-center gap-1.5" title="Whether a voice session is active on the PC">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        myraState === "ACTIVE" ? "bg-emerald-400" : "bg-slate-600"
                      }`}
                    />
                    {myraState === "ACTIVE" ? "PC session live" : "PC session off"}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        snapshot?.mic.streaming ? "bg-emerald-400" : "bg-slate-600"
                      }`}
                    />
                    {snapshot?.mic.streaming ? "Server receiving" : "Server idle"}
                  </span>
                </div>

                {myraState !== "ACTIVE" && (
                  <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-amber-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                    No active Myra session on the PC. Press CONNECT VOICE on the laptop; the phone
                    microphone then streams into that same session.
                  </p>
                )}

                {audioNotice && (
                  <p className="mt-3 flex items-start gap-2 rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-[10px] leading-relaxed text-cyan-200">
                    <MicOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300" />
                    {audioNotice}
                  </p>
                )}

                {micError && (
                  <p className="mt-3 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-950/40 px-3 py-2 text-[10px] leading-relaxed text-red-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                    {micError}
                  </p>
                )}
              </section>

              <section className="grid grid-cols-2 gap-3">
                <StatusCard
                  icon={snapshot?.pc.connected ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
                  label="Myra PC"
                  value={snapshot?.pc.connected ? "Connected" : "Not connected"}
                  tone={snapshot?.pc.connected ? "ok" : "bad"}
                  detail={myraState === "ACTIVE" ? "PC voice active" : "PC voice idle"}
                />
                <StatusCard
                  icon={<Mic className="h-4 w-4" />}
                  label="Mic source"
                  value="Phone (default)"
                  tone="info"
                  detail={snapshot?.mic.streaming ? "Streaming" : "Not streaming yet"}
                />
                <StatusCard
                  icon={<Smartphone className="h-4 w-4" />}
                  label="Phone link"
                  value={snapshot?.remote.phoneConnected ? "Connected" : "Offline"}
                  tone={snapshot?.remote.phoneConnected ? "ok" : "bad"}
                  detail={snapshot?.remote.deviceName || undefined}
                />
                <StatusCard
                  icon={<Server className="h-4 w-4" />}
                  label="Remote server"
                  value={snapshot?.remote.enabled ? "Secure" : "Disabled"}
                  tone={snapshot?.remote.enabled ? "ok" : "bad"}
                  detail={snapshot ? `${Math.floor(snapshot.uptimeMs / 1000)}s uptime` : undefined}
                />
              </section>

              <section className="glass-panel rounded-2xl border border-white/10 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-slate-500">
                      Paired device
                    </p>
                    <p className="mt-1 truncate text-sm text-slate-200">
                      {snapshot?.remote.deviceName || deviceName || "This phone"}
                    </p>
                  </div>
                  <button
                    onClick={unpair}
                    className="shrink-0 rounded-xl border border-white/10 px-3 py-2 font-mono text-[9px] uppercase tracking-wider text-slate-400 transition hover:border-red-500/30 hover:bg-red-950/30 hover:text-red-300"
                  >
                    Unpair
                  </button>
                </div>
                <p className="mt-3 flex items-center gap-1.5 text-[10px] text-slate-500">
                  <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                  Session is authenticated with an HttpOnly cookie. The desktop token never reaches
                  this phone.
                </p>
              </section>
            </>
          )}

          {phase === "error" && !snapshot && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
              <WifiOff className="h-8 w-8 text-red-400" />
              <p className="text-sm text-slate-300">{errorText || "Could not reach the Myra PC."}</p>
              <button
                onClick={() => connectRef.current()}
                className="mt-2 rounded-xl border border-cyan-400/40 bg-cyan-500/15 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-cyan-200"
              >
                Retry
              </button>
            </div>
          )}
        </main>

        <footer className="mt-6 flex items-center justify-center gap-2 border-t border-white/5 pt-4 text-center font-mono text-[9px] uppercase tracking-[0.18em] text-slate-600">
          <ShieldCheck className="h-3 w-3 text-cyan-500/70" />
          Tailscale HTTPS · paired session · no public endpoint
        </footer>
      </div>
    </div>
  );
}

function StatusCard({
  icon,
  label,
  value,
  tone,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone: "ok" | "bad" | "info";
  detail?: string;
}) {
  const toneClass =
    tone === "ok"
      ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-300"
      : tone === "bad"
        ? "border-red-500/25 bg-red-500/5 text-red-300"
        : "border-cyan-500/25 bg-cyan-500/5 text-cyan-300";

  return (
    <div className="glass-panel rounded-2xl border border-white/10 p-3.5">
      <div className={`flex items-center gap-1.5 ${toneClass} w-fit rounded-lg border px-2 py-1`}>
        {icon}
        <span className="font-mono text-[8px] uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-2 text-sm font-medium text-slate-100">{value}</p>
      {detail && <p className="mt-0.5 text-[9px] text-slate-500">{detail}</p>}
    </div>
  );
}
