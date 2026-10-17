#!/usr/bin/env node
/**
 * Generates a genuine speech WAV fixture through the live OpenRouter API:
 * asks an audio-capable model to say a sentence (streaming pcm16), wraps the
 * PCM in a WAV header (24 kHz mono, matching gpt-audio output), and prints a
 * JSON descriptor as the last stdout line:
 *
 *   {"path": "...", "transcript": "...", "bytes": N, "seconds": S}
 *
 * Used by the live e2e leg and the Playwright live voice spec as the audio
 * source for Chrome's file-backed fake capture device (--use-file-for-
 * fake-audio-capture), standing in for a human microphone in a headless VM.
 *
 * Usage: node scripts/make-mic-fixture.mjs [--out PATH] [--text SENTENCE]
 *          [--model ID] [--voice alloy]
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const {
  values: { out, text, model, voice },
} = parseArgs({
  options: {
    out: { type: "string", default: "/tmp/voice-session-mic.wav" },
    text: {
      type: "string",
      default:
        "Hello! This is a live voice turn test for the voice session app. Can you hear me clearly?",
    },
    model: { type: "string", default: "openai/gpt-audio" },
    voice: { type: "string", default: "alloy" },
  },
});

const RATE = 24000; // gpt-audio streaming pcm16 output rate (verified live)

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error("Set OPENROUTER_API_KEY to synthesize a fixture.");
  process.exit(1);
}

const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,
    modalities: ["text", "audio"],
    audio: { voice, format: "pcm16" },
    stream: true,
    messages: [{ role: "user", content: `Say exactly: ${text}` }],
  }),
});

if (!res.ok || !res.body) {
  console.error(`TTS request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}

let transcript = "";
const pcmChunks = [];
const parser = new (await import("../lib/sse.ts")).SseParser();
const reader = res.body.getReader();
const decoder = new TextDecoder();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  for (const sse of parser.feed(decoder.decode(value, { stream: true }))) {
    if (sse.data === "[DONE]") continue;
    try {
      const delta = JSON.parse(sse.data).choices?.[0]?.delta ?? {};
      if (typeof delta.audio?.transcript === "string") transcript += delta.audio.transcript;
      if (typeof delta.audio?.data === "string" && delta.audio.data) {
        pcmChunks.push(Buffer.from(delta.audio.data, "base64"));
      }
    } catch {
      // ignore malformed lines
    }
  }
}

const pcm = Buffer.concat(pcmChunks);
if (pcm.length === 0) {
  console.error("TTS produced no audio.");
  process.exit(1);
}

function wavWrap(pcmBuffer, rate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

const wav = wavWrap(pcm, RATE);
writeFileSync(out, wav);
process.stdout.write(
  `${JSON.stringify({
    path: out,
    transcript: transcript.trim(),
    bytes: wav.length,
    seconds: Number((pcm.length / 2 / RATE).toFixed(2)),
    sampleRate: RATE,
  })}\n`,
);