import test from "node:test";
import assert from "node:assert/strict";
import { base64ToBytes, pcm16ToFloat32 } from "../../lib/pcm.ts";

test("base64ToBytes decodes in Node and rejects junk gracefully", () => {
  const bytes = base64ToBytes(Buffer.from("hello world").toString("base64"));
  assert.equal(Buffer.from(bytes).toString("utf8"), "hello world");
  assert.deepEqual([...base64ToBytes("")], []);
});

test("pcm16ToFloat32 converts 16-bit LE samples to [-1, 1] floats", () => {
  // +0.5 = 0x0000 0x40 00 ... little endian: 16384 -> 0.5
  const buf = Buffer.alloc(4);
  buf.writeInt16LE(16384, 0);
  buf.writeInt16LE(-16384, 2);
  const samples = pcm16ToFloat32(new Uint8Array(buf));
  assert.ok(Math.abs(samples[0] - 0.5) < 1e-4);
  assert.ok(Math.abs(samples[1] + 0.5) < 1e-4);
});

test("pcm16ToFloat32 drops a trailing odd byte", () => {
  const buf = new Uint8Array(5);
  buf.set([0x00, 0x40, 0x00, 0xc0, 0xff], 0);
  const samples = pcm16ToFloat32(buf);
  assert.equal(samples.length, 2);
});

test("pcm16ToFloat32 clamps silence to exact zero", () => {
  assert.deepEqual([...pcm16ToFloat32(new Uint8Array(8))], [0, 0, 0, 0]);
});