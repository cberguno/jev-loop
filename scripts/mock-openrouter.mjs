#!/usr/bin/env node
/**
 * A tiny OpenRouter-compatible mock for local development and the e2e loop.
 * Implements POST /api/v1/chat/completions (SSE streaming) and
 * GET /api/v1/models, validating that audio turns arrive as
 * `input_audio` content parts with base64 `data` + `format`.
 *
 * Run: node scripts/mock-openrouter.mjs [port]
 */
import http from "node:http";

const port = Number(process.argv[2] ?? process.env.OPENROUTER_MOCK_PORT ?? 4141);
const MOCK_TRANSCRIPT = "Hello from the mock audio transcription.";
const MOCK_REPLY = ["Hello", " from", " the", " mock", " model."];

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
  const audioPart =
    isRecord(last) && Array.isArray(last.content)
      ? last.content.find(
          (part) => isRecord(part) && part.type === "input_audio" && isRecord(part.input_audio),
        )
      : null;

  console.log(
    JSON.stringify({
      route: "chat/completions",
      model: body.model,
      stream: body.stream,
      modalities: body.modalities,
      include: body.include,
      messages: messages.length,
      audioPart: audioPart
        ? {
            format: audioPart.input_audio.format,
            base64Bytes: Math.floor((audioPart.input_audio.data.length * 3) / 4),
            decodedHeader: Buffer.from(audioPart.input_audio.data, "base64")
              .subarray(0, 4)
              .toString("latin1"),
          }
        : null,
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

  if (audioPart) {
    const bytes = Buffer.from(audioPart.input_audio.data, "base64");
    if (audioPart.input_audio.format !== "wav" || bytes.subarray(0, 4).toString("latin1") !== "RIFF") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Audio must be RIFF/WAV base64." } }));
      return;
    }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  res.write(": openrouter mock stream\n\n");

  if (audioPart) {
    // How audio models deliver the user's input transcription.
    sse(res, {
      choices: [{ index: 0, delta: { input_audio_transcription: { text: MOCK_TRANSCRIPT } } }],
    });
  }
  for (const piece of MOCK_REPLY) {
    sse(res, {
      choices: [{ index: 0, delta: { content: piece } }],
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