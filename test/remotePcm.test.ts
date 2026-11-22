/**
 * Phase 2 targeted tests: PCM resampling / encoding helpers.
 *
 * Run with: npx tsx test/remotePcm.test.ts
 */

import {
  PCM16_CHUNK_BYTES,
  PCM16_CHUNK_SAMPLES,
  Pcm16Chunker,
  bytesToBase64,
  floatToPcm16LE,
  resampleTo16k,
} from "../src/remote/pcm.js";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function approx(actual: number, expected: number, tolerance = 1e-6): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

// --- resampling -----------------------------------------------------------
{
  const input = new Float32Array(4_800).fill(0.5);
  const output = resampleTo16k(input, 48_000);
  check(output.length === 1_600, "48 kHz -> 16 kHz must produce one third of the samples");
  check(
    output.every((sample) => approx(sample, 0.5, 1e-5)),
    "resampling a constant signal must preserve its value"
  );
}

{
  const input = new Float32Array(1_600).fill(0.25);
  const output = resampleTo16k(input, 16_000);
  check(output === input, "16 kHz input must pass through unchanged");
}

{
  const ramp = Float32Array.from({ length: 96_000 }, (_, i) => i / 96_000);
  const output = resampleTo16k(ramp, 48_000);
  check(output.length === 32_000, "resampled length must follow floor(len / ratio)");
  check(output[0] === ramp[0], "first sample must be preserved");
  check(
    output[1] > output[0] && output[output.length - 1] <= 1,
    "resampled ramp must stay monotonic and in range"
  );
}

// --- PCM16 little-endian --------------------------------------------------
{
  const pcm = floatToPcm16LE(Float32Array.from([0, 1, -1, 0.5]));
  check(pcm.byteLength === 8, "four samples must produce eight bytes");
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  check(view.getInt16(0, true) === 0, "0.0 must encode as 0");
  check(view.getInt16(2, true) === 32767, "+1.0 must encode as 32767");
  check(view.getInt16(4, true) === -32768, "-1.0 must encode as -32768");
  check(view.getInt16(6, true) === 16384, "+0.5 must encode as 16384 (rounded)");
}

{
  const sample = 0x1234 / 0x7fff;
  const pcm = floatToPcm16LE(Float32Array.from([sample]));
  const expected = Math.round(sample * 0x7fff);
  check(
    pcm[0] === (expected & 0xff) && pcm[1] === (expected >> 8),
    "PCM16 samples must be written little-endian (low byte first)"
  );
}

// --- base64 ---------------------------------------------------------------
{
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  check(
    bytesToBase64(bytes) === Buffer.from(bytes).toString("base64"),
    "base64 output must match the reference encoder"
  );
}

// --- chunking -------------------------------------------------------------
{
  const chunker = new Pcm16Chunker();
  const oneSecond = new Float32Array(16_000).fill(0.1);
  const chunks = chunker.push(oneSecond);
  check(chunks.length === 10, "one second of audio must produce ten 100 ms chunks");
  check(
    chunks.every((chunk) => chunk.byteLength === PCM16_CHUNK_BYTES),
    "each full chunk must be exactly 3200 PCM16 bytes"
  );
  check(chunker.flush() === null, "a full chunker must not emit a trailing chunk");
}

{
  const chunker = new Pcm16Chunker();
  const chunks = chunker.push(new Float32Array(PCM16_CHUNK_SAMPLES + 10).fill(0.1));
  check(chunks.length === 1, "one full chunk plus a partial must emit one chunk");
  const trailing = chunker.flush();
  check(trailing !== null && trailing.byteLength === 20, "flush must emit the remaining 10 samples");
  check(chunker.flush() === null, "flush must be idempotent");
}

console.log("remotePcm: all checks passed");
