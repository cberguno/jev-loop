import test from "node:test";
import assert from "node:assert/strict";
import { encodeWav, encodeWavFromChannels, mixdownToMono } from "../../lib/wav.ts";

function readHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  return {
    riff: tag(0),
    wave: tag(8),
    fmt: tag(12),
    data: tag(36),
    fileSize: view.getUint32(4, true),
    fmtChunkSize: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataSize: view.getUint32(40, true),
  };
}

test("encodeWav writes a canonical 16-bit mono PCM header", () => {
  const samples = new Float32Array(1600); // 0.1s at 16 kHz
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.5;
  }
  const bytes = encodeWav(samples, 16000);
  const header = readHeader(bytes);
  assert.equal(header.riff, "RIFF");
  assert.equal(header.wave, "WAVE");
  assert.equal(header.fmt, "fmt ");
  assert.equal(header.data, "data");
  assert.equal(header.format, 1); // PCM
  assert.equal(header.channels, 1);
  assert.equal(header.sampleRate, 16000);
  assert.equal(header.byteRate, 32000);
  assert.equal(header.blockAlign, 2);
  assert.equal(header.bitsPerSample, 16);
  assert.equal(header.dataSize, samples.length * 2);
  assert.equal(header.fileSize, 36 + samples.length * 2);
  assert.equal(bytes.length, 44 + samples.length * 2);
});

test("encodeWav clamps samples into int16 range", () => {
  const bytes = encodeWav(new Float32Array([0, 1, -1, 2, -2]), 8000);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 0x7fff);
  assert.equal(view.getInt16(48, true), -0x8000);
  assert.equal(view.getInt16(50, true), 0x7fff);
  assert.equal(view.getInt16(52, true), -0x8000);
});

test("encodeWav rejects empty and invalid input", () => {
  assert.throws(() => encodeWav(new Float32Array(0), 16000), /empty/);
  assert.throws(() => encodeWav(new Float32Array(4), 0), /sample rate/i);
});

test("mixdownToMono averages stereo channels", () => {
  const left = new Float32Array([1, 2, 3]);
  const right = new Float32Array([3, 4, 8]);
  const mono = mixdownToMono([left, right]);
  assert.deepEqual([...mono], [2, 3, 5.5]);
  assert.deepEqual([...mixdownToMono([])], []);
  assert.deepEqual([...mixdownToMono([left])], [1, 2, 3]);
});

test("encodeWavFromChannels mixes down and encodes", () => {
  const channels = [new Float32Array([0.25, -0.25]), new Float32Array([0.75, 0.25])];
  const bytes = encodeWavFromChannels(channels, 8000);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint16(22, true), 1); // mono after mixdown
  const first = view.getInt16(44, true) / 0x7fff;
  assert.ok(Math.abs(first - 0.5) < 0.01, `first sample ~0.5, got ${first}`);
});