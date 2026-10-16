/**
 * Minimal 16-bit PCM WAV encoder, shared by the browser recorder and tests.
 * Pure functions only so both the DOM path (`Float32Array` from
 * decodeAudioData) and Node tests can use it.
 */

/** Mix any channel layout down to a single mono channel. */
export function mixdownToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0] ?? new Float32Array(0);
  const length = channels[0]?.length ?? 0;
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) {
      sum += channel[i] ?? 0;
    }
    mono[i] = sum / channels.length;
  }
  return mono;
}

function writeString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/** Encode mono float samples [-1, 1] as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  if (sampleRate <= 0 || !Number.isFinite(sampleRate)) {
    throw new Error(`Invalid sample rate: ${sampleRate}`);
  }
  if (samples.length === 0) {
    throw new Error("Refusing to encode an empty recording");
  }
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return bytes;
}

/** Encode interleaved audio (the output of AudioBuffer channels) as WAV. */
export function encodeWavFromChannels(
  channels: Float32Array[],
  sampleRate: number,
): Uint8Array {
  return encodeWav(mixdownToMono(channels), sampleRate);
}