/**
 * Myra AI — Phase 2 remote audio bridge.
 *
 * The phone never owns a Gemini session. It streams PCM16 chunks over the
 * authenticated /remote/ws socket and this bridge forwards them to the ONE
 * Gemini Live session that the desktop already established on /ws.
 *
 * Design constraints:
 *  - No provider/session creation here. If no desktop session is attached,
 *    push() reports `noSession` instead of inventing one (Phase 3 lifecycle).
 *  - Nothing is buffered. A chunk is forwarded immediately or rejected.
 *  - A token bucket bounds the accepted byte rate so a paired phone cannot
 *    flood Gemini or the server.
 *  - Exactly one sink is active at a time (the most recently attached desktop
 *    connection); detaching it falls back to the previous live session.
 */

export interface RemoteAudioSink {
  /** Forward base64 PCM16 mono 16 kHz audio to the provider session. */
  sendAudio(base64Pcm: string): void;
}

export interface RemoteAudioPushResult {
  ok: boolean;
  reason?: "noSession" | "rateLimited" | "sendFailed";
}

export interface RemoteAudioBridgeOptions {
  /** Sustained accepted audio rate. Real-time PCM16/16 kHz is 32_000 B/s. */
  maxBytesPerSecond?: number;
  /** Maximum burst allowance (also the initial bucket size). */
  burstBytes?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export const DEFAULT_AUDIO_BYTES_PER_SECOND = 64 * 1024;
export const DEFAULT_AUDIO_BURST_BYTES = 48 * 1024;

export class RemoteAudioBridge {
  private readonly sinks = new Map<string, RemoteAudioSink>();
  private readonly maxBytesPerSecond: number;
  private readonly burstBytes: number;
  private readonly now: () => number;

  private activeSessionIdValue: string | null = null;
  private tokens: number;
  private lastRefillAt: number;

  constructor(options: RemoteAudioBridgeOptions = {}) {
    this.maxBytesPerSecond = options.maxBytesPerSecond ?? DEFAULT_AUDIO_BYTES_PER_SECOND;
    this.burstBytes = options.burstBytes ?? DEFAULT_AUDIO_BURST_BYTES;
    this.now = options.now ?? Date.now;
    this.tokens = this.burstBytes;
    this.lastRefillAt = this.now();
  }

  /**
   * Register the provider session belonging to a desktop /ws connection.
   * Returns an idempotent detach function.
   */
  attach(sessionId: string, sink: RemoteAudioSink): () => void {
    this.sinks.set(sessionId, sink);
    this.activeSessionIdValue = sessionId;
    return () => this.detach(sessionId);
  }

  /** Remove a desktop session. Falls back to the newest remaining sink. */
  detach(sessionId: string): void {
    this.sinks.delete(sessionId);
    if (this.activeSessionIdValue !== sessionId) return;
    const remaining = Array.from(this.sinks.keys());
    this.activeSessionIdValue = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }

  get hasSession(): boolean {
    return this.activeSessionIdValue !== null && this.sinks.has(this.activeSessionIdValue);
  }

  get activeSessionId(): string | null {
    return this.activeSessionIdValue;
  }

  /**
   * Forward one already-validated PCM16 chunk. `byteLength` is the decoded
   * byte length (used for the rate bucket).
   */
  push(base64Pcm: string, byteLength: number): RemoteAudioPushResult {
    if (!this.activeSessionIdValue) return { ok: false, reason: "noSession" };
    const sink = this.sinks.get(this.activeSessionIdValue);
    if (!sink) {
      this.activeSessionIdValue = null;
      return { ok: false, reason: "noSession" };
    }

    if (byteLength <= 0) return { ok: false, reason: "sendFailed" };

    this.refill();
    if (byteLength > this.tokens) return { ok: false, reason: "rateLimited" };
    this.tokens -= byteLength;

    try {
      sink.sendAudio(base64Pcm);
      return { ok: true };
    } catch {
      return { ok: false, reason: "sendFailed" };
    }
  }

  dispose(): void {
    this.sinks.clear();
    this.activeSessionIdValue = null;
    this.tokens = 0;
  }

  private refill(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefillAt);
    this.lastRefillAt = now;
    this.tokens = Math.min(this.burstBytes, this.tokens + (elapsed * this.maxBytesPerSecond) / 1000);
  }
}
