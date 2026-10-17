#!/usr/bin/env node
/**
 * A tiny OpenRouter-compatible mock for local development and the e2e loop.
 * Mirrors the live gpt-audio wire format verified against OpenRouter:
 *
 * - `input_audio` content parts carry base64 `data` + `format`.
 * - Replies stream as `delta.audio.transcript` (text modality rides on the
 *   audio transcript), plus `delta.audio.data` pcm16 chunks (24 kHz mono).
 * - Text-only modality requests with no input audio are rejected, like the
 *   real provider ("requires that either input content or output modality
 *   contain audio").
 *
 * Run: node scripts/mock-openrouter.mjs [port]
 */
import http from "node:http";

const port = Number(process.argv[2] ?? process.env.OPENROUTER_MOCK_PORT ?? 4141);
const MOCK_TRANSCRIPT = "Hello from the mock audio transcription.";
const MOCK_REPLY = "Hello from the mock model.";
const PCM_RATE = 24000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function sse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** A short sine burst as pcm16, base64, like real streamed reply audio. */
function pcmChunk(seconds = 0.4) {
  const n = Math.floor(seconds * PCM_RATE);
  const bytes = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    bytes.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / PCM_RATE) * 6000));
  }
  return bytes.toString("base64");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (req.method === "GET" && url.pathname === "/api/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "openai/gpt-audio" }] }));
    return;
  }
  if (req.method !== "POST" || url.pathname !== "/api/v1/chat/completions") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `No route: ${req.method} ${url.pathname}` } }));
    return;
  }

  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ") || auth.length < 10) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Missing bearer token." } }));
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "JSON parsing failed" } }));
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages[messages.length - 1];
  const modalities = Array.isArray(body.modalities) ? body.modalities : [];
  const hasInputAudio =
    isRecord(last) &&
    Array.isArray(last.content) &&
    last.content.some(
      (part) => isRecord(part) && part.type === "input_audio" && isRecord(part.input_audio),
    );

  console.log(
    JSON.stringify({
      route: "chat/completions",
      model: body.model,
      stream: body.stream,
      modalities,
      voice: body.audio?.voice,
      messages: messages.length,
      hasInputAudio,
    }),
  );

  const textOf = (message) => {
    if (!isRecord(message)) return "";
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join(" ");
    }
    return "";
  };

  if (String(textOf(last)).includes("trigger error")) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Mock upstream exploded." } }));
    return;
  }

  if (!hasInputAudio && !modalities.includes("audio")) {
    // Mirror the real provider constraint.
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "This model requires that either input content or output modality contain audio.",
        },
      }),
    );
    return;
  }

  if (hasInputAudio) {
    const part = last.content.find((p) => isRecord(p) && p.type === "input_audio");
    const bytes = Buffer.from(part.input_audio.data, "base64");
    if (part.input_audio.format !== "wav" || bytes.subarray(0, 4).toString("latin1") !== "RIFF") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "Recording must be RIFF/WAVE base64." } }),
      );
      return;
    }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  res.write(": openrouter mock stream\n\n");

const reply = hasInputAudio
    ? `TRANSCRIPT: ${MOCK_TRANSCRIPT}\nREPLY: ${MOCK_REPLY}`
    : MOCK_REPLY;
  // Reply text arrives as the audio transcript, like the live provider.
  for (const piece of [reply.slice(0, 8), reply.slice(8)]) {
    sse(res, {
      choices: [{ index: 0, delta: { audio: { transcript: piece } } }],
      model: body.model,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  // Spoken reply audio chunks (the ASR stage's chunks are simply discarded
  // by the server route, exactly like the live flow).
  for (let i = 0; i < 2; i++) {
    sse(res, {
      choices: [{ index: 0, delta: { audio: { data: pcmChunk() } } }],
      model: body.model,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(port, () => {
  console.log(`mock openrouter listening on http://127.0.0.1:${port}`);
});