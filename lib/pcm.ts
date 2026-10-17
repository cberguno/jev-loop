/**
 * PCM16 helpers for playing streamed spoken replies (gpt-audio pcm16 @24kHz).
 * Pure functions, usable from the browser hook and Node tests.
 */

/** Decode base64 to raw bytes (atob in the browser, Buffer in Node). */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, "");
  if (typeof atob === "function") {
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  if (typeof Buffer === "function" && typeof Buffer.from === "function") {
    return new Uint8Array(Buffer.from(clean, "base64"));
  }
  throw new Error("No base64 decoder available");
}

/** Read a 16-bit little-endian sample at `offset` (byte index). */
function readInt16LE(bytes: Uint8Array, offset: number): number {
  const lo = bytes[offset] ?? 0;
  const hi = bytes[offset + 1] ?? 0;
  const value = (hi << 8) | lo;
  return value >= 0x8000 ? value - 0x10000 : value;
}

/** Convert raw mono 16-bit PCM to float samples in [-1, 1]. */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const usable = bytes.length - (bytes.length % 2);
  const samples = new Float32Array(Math.floor(usable / 2));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = readInt16LE(bytes, i * 2) / 32768;
  }
  return samples;
}