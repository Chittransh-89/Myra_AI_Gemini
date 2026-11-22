/**
 * Phase 2 phone microphone capture.
 *
 * Captures the phone microphone, resamples to mono 16 kHz PCM16 little-endian,
 * and emits bounded 100 ms chunks. The consumer (RemoteApp) is responsible for
 * sending them over the authenticated /remote/ws socket and for dropping
 * chunks when the socket is backed up.
 *
 * All hardware resources (MediaStream tracks, ScriptProcessorNode,
 * AudioContext) are released by stop(); stop() is idempotent and safe to call
 * from a WebSocket close handler or React cleanup.
 */

import {
  PCM16_SAMPLE_RATE,
  Pcm16Chunker,
  bytesToBase64,
  resampleTo16k,
} from "./pcm";

export interface PhoneAudioChunk {
  base64: string;
  /** Decoded PCM16 byte length. */
  bytes: number;
}

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

export class PhoneAudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private readonly chunker = new Pcm16Chunker();
  private active = false;
  private cancelled = false;

  get isActive(): boolean {
    return this.active;
  }

  async start(onChunk: (chunk: PhoneAudioChunk) => void): Promise<void> {
    if (this.active) return;
    this.cancelled = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not available in this browser.");
    }
    if (!window.isSecureContext) {
      throw new Error("Microphone access requires HTTPS. Open Myra through Tailscale Serve.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: { ideal: PCM16_SAMPLE_RATE },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    if (this.cancelled) {
      stopTracks(stream);
      return;
    }

    const AudioContextClass: AudioContextConstructor =
      window.AudioContext || (window as any).webkitAudioContext;
    let context: AudioContext;
    try {
      // Prefer native 16 kHz. If the browser refuses the rate, resample below.
      context = new AudioContextClass({ sampleRate: PCM16_SAMPLE_RATE });
    } catch {
      context = new AudioContextClass();
    }

    if (this.cancelled) {
      stopTracks(stream);
      void context.close().catch(() => {});
      return;
    }

    try {
      if (context.state === "suspended") {
        await context.resume();
      }

      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      // A muted sink keeps the processor pulling audio without emitting sound.
      const sink = context.createGain();
      sink.gain.value = 0;

      processor.onaudioprocess = (event) => {
        if (!this.active) return;
        const input = event.inputBuffer.getChannelData(0);
        const resampled = resampleTo16k(input, context.sampleRate);
        for (const pcm of this.chunker.push(resampled)) {
          onChunk({ base64: bytesToBase64(pcm), bytes: pcm.byteLength });
        }
      };

      source.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);

      this.stream = stream;
      this.context = context;
      this.source = source;
      this.processor = processor;
      this.sink = sink;
      this.active = true;
    } catch (error) {
      stopTracks(stream);
      void context.close().catch(() => {});
      throw error;
    }
  }

  stop(): void {
    this.cancelled = true;
    this.active = false;
    this.chunker.reset();

    if (this.processor) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
      } catch {
        /* already disconnected */
      }
      this.processor = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* already disconnected */
      }
      this.source = null;
    }
    if (this.sink) {
      try {
        this.sink.disconnect();
      } catch {
        /* already disconnected */
      }
      this.sink = null;
    }
    if (this.stream) {
      stopTracks(this.stream);
      this.stream = null;
    }
    if (this.context) {
      const context = this.context;
      this.context = null;
      void context.close().catch(() => {});
    }
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* track already ended */
    }
  }
}
