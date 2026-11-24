/**
 * Myra AI — Phase 1 remote status runtime.
 *
 * This is intentionally a STATUS-ONLY view for Phase 1. The full lifecycle
 * manager (INACTIVE/ACTIVE/STOPPING ownership, phone ON/OFF, single Gemini
 * session) arrives in Phase 3. Until then this runtime reports the existing
 * backend truth:
 *   - whether the desktop app is present (heartbeat or live /ws client),
 *   - whether any legacy Gemini session is currently established,
 *   - whether a phone is connected over /remote/ws,
 *   - the fixed remote microphone policy (phone is the default).
 *
 * It never starts, stops, or otherwise changes a Gemini session.
 */

export type MyraLifecycleState = "INACTIVE" | "ACTIVE" | "STOPPING";

export interface RemoteSnapshot {
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
    state: MyraLifecycleState;
    /** "legacy" until Phase 3 replaces this with the managed lifecycle. */
    mode: "legacy";
    /** True while model audio for the current turn is being delivered. */
    speaking: boolean;
  };
  mic: {
    /** Phase 1 policy: phone is the default/primary remote microphone. */
    source: "phone";
    defaultSource: "phone";
    /**
     * True only after the user explicitly turned Phone Remote ON. The server
     * rejects audio frames until then; nothing enables this automatically.
     */
    enabled: boolean;
    /** True while accepted phone audio is actually reaching Gemini. */
    streaming: boolean;
  };
  error: string | null;
}

export interface RemoteRuntimeOptions {
  enabled: boolean;
  publicUrl: string | null;
  /** How long after the last desktop heartbeat we still consider the PC present. */
  desktopTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_DESKTOP_TIMEOUT_MS = 45_000;

export class RemoteRuntime {
  private readonly enabled: boolean;
  private readonly publicUrl: string | null;
  private readonly desktopTimeoutMs: number;
  private readonly now: () => number;
  private readonly startedAt: number;

  private readonly desktopClients = new Set<string>();
  private readonly establishedSessions = new Set<string>();
  private desktopLastSeenAt = 0;

  private phone: { id: string; deviceName: string; connectedAt: number } | null = null;
  private phoneMicEnabled = false;
  private phoneStreaming = false;
  private myraSpeaking = false;
  private lastError: string | null = null;

  private readonly listeners = new Set<(snapshot: RemoteSnapshot) => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private lastSerialized = "";

  constructor(options: RemoteRuntimeOptions) {
    this.enabled = options.enabled;
    this.publicUrl = options.publicUrl;
    this.desktopTimeoutMs = options.desktopTimeoutMs ?? DEFAULT_DESKTOP_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();

    // Recompute periodically so a stale PC heartbeat flips to disconnected even
    // if nothing else changes.
    this.timer = setInterval(() => this.emitIfChanged(), 10_000);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  subscribe(listener: (snapshot: RemoteSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called by the authenticated desktop pairing-info endpoint. */
  touchDesktop(): void {
    this.desktopLastSeenAt = this.now();
    this.emitIfChanged();
  }

  desktopConnected(sessionId: string): void {
    this.desktopClients.add(sessionId);
    this.touchDesktop();
  }

  desktopDisconnected(sessionId: string): void {
    this.desktopClients.delete(sessionId);
    this.establishedSessions.delete(sessionId);
    this.myraSpeaking = false;
    this.emitIfChanged();
  }

  markSessionEstablished(sessionId: string): void {
    this.establishedSessions.add(sessionId);
    this.touchDesktop();
  }

  clearSessionEstablished(sessionId: string): void {
    this.establishedSessions.delete(sessionId);
    this.myraSpeaking = false;
    this.emitIfChanged();
  }

  /**
   * True while Myra is delivering model audio for this turn. The phone mic is
   * gated on this so speaker echo (or room noise) cannot interrupt her
   * mid-sentence — the main cause of choppy PC speech when a phone was left
   * streaming.
   */
  setMyraSpeaking(speaking: boolean): void {
    if (this.myraSpeaking === speaking) return;
    this.myraSpeaking = speaking;
    this.emitIfChanged();
  }

  isMyraSpeaking(): boolean {
    return this.myraSpeaking;
  }

  setPhone(session: { id: string; deviceName: string }): void {
    this.phone = {
      id: session.id,
      deviceName: session.deviceName,
      connectedAt: this.now(),
    };
    // A (re)connected phone always starts with Phone Remote OFF. It must be
    // enabled by an explicit user action on that socket.
    this.phoneMicEnabled = false;
    this.phoneStreaming = false;
    this.emitIfChanged();
  }

  /** Explicit manual Phone Remote ON/OFF for the connected phone. */
  setPhoneMicEnabled(enabled: boolean): void {
    const next = enabled && this.phone !== null;
    if (this.phoneMicEnabled === next) return;
    this.phoneMicEnabled = next;
    if (!next) this.phoneStreaming = false;
    this.emitIfChanged();
  }

  isPhoneMicEnabled(): boolean {
    return this.phone !== null && this.phoneMicEnabled;
  }

  /** Phase 2: true while accepted phone audio is flowing into Gemini. */
  setPhoneStreaming(streaming: boolean): void {
    if (this.phoneStreaming === streaming) return;
    this.phoneStreaming = streaming;
    this.emitIfChanged();
  }

  clearPhone(sessionId?: string): void {
    if (!this.phone) return;
    if (sessionId && this.phone.id !== sessionId) return;
    this.phone = null;
    this.phoneMicEnabled = false;
    this.phoneStreaming = false;
    this.emitIfChanged();
  }

  setError(message: string | null): void {
    this.lastError = message;
    this.emitIfChanged();
  }

  snapshot(): RemoteSnapshot {
    const now = this.now();
    const heartbeatFresh =
      this.desktopLastSeenAt > 0 && now - this.desktopLastSeenAt < this.desktopTimeoutMs;
    const pcConnected = this.desktopClients.size > 0 || heartbeatFresh;

    return {
      serverTime: now,
      uptimeMs: Math.max(0, now - this.startedAt),
      remote: {
        enabled: this.enabled,
        publicUrl: this.publicUrl,
        phoneConnected: this.phone !== null,
        deviceName: this.phone ? this.phone.deviceName : null,
        connectedAt: this.phone ? this.phone.connectedAt : null,
      },
      pc: {
        connected: pcConnected,
        lastSeenAt: this.desktopLastSeenAt > 0 ? this.desktopLastSeenAt : null,
        clients: this.desktopClients.size,
      },
      myra: {
        // Phase 1 has no managed lifecycle yet. "ACTIVE" here means the
        // existing legacy Gemini session is established on a desktop /ws.
        state: this.establishedSessions.size > 0 ? "ACTIVE" : "INACTIVE",
        mode: "legacy",
        speaking: this.myraSpeaking,
      },
      mic: {
        source: "phone",
        defaultSource: "phone",
        enabled: this.phone !== null && this.phoneMicEnabled,
        streaming: this.phone !== null && this.phoneStreaming,
      },
      error: this.lastError,
    };
  }

  dispose(): void {
    clearInterval(this.timer);
    this.listeners.clear();
    this.desktopClients.clear();
    this.establishedSessions.clear();
    this.phone = null;
    this.phoneMicEnabled = false;
    this.phoneStreaming = false;
    this.myraSpeaking = false;
  }

  private emitIfChanged(): void {
    const snapshot = this.snapshot();
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.lastSerialized) return;
    this.lastSerialized = serialized;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* a broken listener must never affect the server */
      }
    }
  }
}
