/**
 * Phase 2 phone audio helpers.
 *
 * The Gemini Live input format is fixed: mono, 16 kHz, signed 16-bit
 * little-endian PCM. Phone AudioContexts commonly run at 44.1/48 kHz, so the
 * capture path resamples before encoding. These helpers are pure and are
 * covered by test/remotePcm.test.ts.
 */

export const PCM16_SAMPLE_RATE = 16_000;
/** 100 ms of audio at 16 kHz. */
export const PCM16_CHUNK_SAMPLES = 1_600;
/** 100 ms of PCM16 mono = 3_200 bytes. */
export const PCM16_CHUNK_BYTES = PCM16_CHUNK_SAMPLES * 2;

/**
 * Linear-interpolation downsampler. Returns the input unchanged when it is
 * already at 16 kHz. Output length is floor(input.length * 16000 / inputRate).
 */
export function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (!Number.isFinite(inputRate) || inputRate <= 0) return new Float32Array(0);
  if (inputRate === PCM16_SAMPLE_RATE) return input;

  const ratio = inputRate / PCM16_SAMPLE_RATE;
  const outLength = Math.floor(input.length / ratio);
  if (outLength <= 0) return new Float32Array(0);

  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    output[i] = a + (b - a) * fraction;
  }
  return output;
}

/** Convert normalized Float32 samples [-1, 1] to PCM16 little-endian bytes. */
export function floatToPcm16LE(input: Float32Array): Uint8Array {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    const value = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(i * 2, value, true);
  }
  return bytes;
}

/** Base64-encode bytes without exceeding the argument limit of fromCharCode. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * Fixed-size chunker. Emits 100 ms PCM16 chunks so each WebSocket frame stays
 * far below the server's 8 KB decoded chunk cap. `flush()` emits any trailing
 * partial chunk when capture stops.
 */
export class Pcm16Chunker {
  private pending: number[] = [];

  push(samples: Float32Array): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < samples.length; i += 1) {
      this.pending.push(samples[i]);
      if (this.pending.length === PCM16_CHUNK_SAMPLES) {
        chunks.push(floatToPcm16LE(Float32Array.from(this.pending)));
        this.pending = [];
      }
    }
    return chunks;
  }

  flush(): Uint8Array | null {
    if (this.pending.length === 0) return null;
    const samples = Float32Array.from(this.pending);
    this.pending = [];
    return floatToPcm16LE(samples);
  }

  reset(): void {
    this.pending = [];
  }
}
