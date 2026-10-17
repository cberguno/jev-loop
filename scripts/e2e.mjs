#!/usr/bin/env node
/**
 * End-to-end core-loop test:
 *   mic-free audio path  -> POST /api/chat with base64 WAV  -> OpenRouter wire format
 *   typed text path      -> POST /api/chat with text        -> SSE deltas
 *
 * Runs the wire-format-faithful mock (scripts/mock-openrouter.mjs) as the
 * upstream and the production Next.js server as the app, then asserts the
 * normalized SSE events the browser would render.
 *
 * Usage: npm run test:e2e          (builds first)
 *        SKIP_NEXT_BUILD=1 npm run test:e2e
 *        OPENROUTER_REAL_E2E=1 npm run test:e2e   (spawns a SECOND app server
 *        bound to the real OpenRouter API and exercises both audio models
 *        plus a live voice round; needs $OPENROUTER_API_KEY)
 *
 * Note: the live leg deliberately spawns its own app server WITHOUT the
 * OPENROUTER_BASE_URL mock override. An earlier revision ran the "real"
 * case through the mock-bound server, which proved nothing about the live
 * API; this is the corrected, genuinely-live leg.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);

const PORT = 3100;
const MOCK_PORT = 4141;
const LIVE_PORT = 3105;
const BASE = `http://127.0.0.1:${PORT}`;
const LIVE_BASE = `http://127.0.0.1:${LIVE_PORT}`;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/api/v1`;

const failures = [];
let passed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(`${name} ${detail}`);
    console.error(`  FAIL  ${name} ${detail}`);
  }
}

async function waitHealthy(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await delay(300);
  }
  return false;
}

function startProcess(command, args, env) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.log = "";
  const collect = (chunk) => {
    child.log += chunk;
    if (process.env.E2E_VERBOSE) process.stdout.write(chunk);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return child;
}

/** POST /api/chat and collect every normalized SSE event. */
async function chat(baseUrl, body, fetchInit = {}) {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...fetchInit,
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const json = await res.json().catch(() => ({}));
    return { status: res.status, events: [], json };
  }
  const text = await res.text();
  const events = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.startsWith("data:")) {
      try {
        events.push(JSON.parse(line.slice(5).trim()));
      } catch {
        // ignore
      }
    }
  }
  return { status: res.status, events, json: null };
}

function makeWavBase64(seconds = 0.6, sampleRate = 16000) {
  const n = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 6000));
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]).toString("base64");
}

async function main() {
  console.log("e2e: building app (set SKIP_NEXT_BUILD=1 to skip)…");
  if (!process.env.SKIP_NEXT_BUILD) {
    const build = spawn("npm", ["run", "build"], { stdio: "inherit" });
    const code = await new Promise((resolve) => build.on("exit", resolve));
    if (code !== 0) {
      console.error("build failed");
      process.exitCode = 1;
      return;
    }
  }

  console.log(`e2e: starting mock OpenRouter on :${MOCK_PORT}`);
  const mock = startProcess("node", ["scripts/mock-openrouter.mjs", String(MOCK_PORT)], {
    OPENROUTER_API_KEY: "mock-key",
  });
  const app = startProcess("node", ["node_modules/.bin/next", "start", "-p", String(PORT)], {
    OPENROUTER_BASE_URL: MOCK_URL,
    OPENROUTER_API_KEY: "mock-key",
    OPENROUTER_MODEL: "openai/gpt-audio",
  });

  const mockUp = await waitHealthy(`http://127.0.0.1:${MOCK_PORT}/api/v1/models`, 15000);
  const appUp = await waitHealthy(BASE, 60000);
  check("mock upstream is up", mockUp);
  check("next server is up", appUp);
  if (!mockUp || !appUp) {
    console.error("servers failed to start; run with E2E_VERBOSE=1 for logs");
    process.exitCode = 1;
    return;
  }

  try {
    console.log("case: page loads");
    {
      const res = await fetch(BASE);
      const html = await res.text();
      check("GET / returns 200", res.status === 200);
      check("page renders app title", html.includes("voice-session"));
    }

    console.log("case: validation rejects empty turns");
    {
      const { status, json } = await chat(BASE, {});
      check("empty body -> 400", status === 400, `got ${status}`);
      check("error names what to send", typeof json?.error === "string" && /text|audio/i.test(json.error));
    }

    console.log("case: typed text streams assistant deltas + spoken reply");
    {
      const { status, events } = await chat(BASE, {
        model: "openai/gpt-audio",
        text: "Say hello.",
        turns: [{ role: "user", text: "prior turn" }],
      });
      const deltas = events.filter((event) => event.type === "delta");
      const joined = deltas.map((event) => event.text).join("");
      const audioChunks = events.filter((event) => event.type === "audio_chunk");
      check("stream -> 200 SSE", status === 200);
      check("assistant deltas accumulate", joined === "Hello from the mock model.", `got ${JSON.stringify(joined)}`);
      check("no user_transcript for text-only turns", !events.some((event) => event.type === "user_transcript"));
      check("spoken reply audio chunks stream", audioChunks.length >= 2, `got ${audioChunks.length}`);
      check(
        "audio chunks are decodable base64",
        audioChunks.every((event) => {
          try {
            return Buffer.from(event.data, "base64").length > 0 && event.sampleRate === 24000;
          } catch {
            return false;
          }
        }),
      );
      check("stream ends with turn_done", events.at(-1)?.type === "turn_done");
    }

    console.log("case: voice turn streams user transcript + reply");
    {
      const wav = makeWavBase64();
      const { status, events } = await chat(BASE, {
        model: "openai/gpt-audio",
        audio: { data: wav, format: "wav" },
      });
      // Transcripts stream progressively; the LAST event carries the full text.
      const transcript = [...events]
        .reverse()
        .find((event) => event.type === "user_transcript");
      const deltas = events.filter((event) => event.type === "delta");
      const joined = deltas.map((event) => event.text).join("");
      check("audio turn -> 200 SSE", status === 200);
      check("user transcript arrives", transcript?.text === "Hello from the mock audio transcription.", `got ${JSON.stringify(transcript)}`);
      check("model reply streams after transcript", joined === "Hello from the mock model.", `got ${JSON.stringify(joined)}`);
      check(
        "spoken reply chunks stream on voice turns too",
        events.filter((event) => event.type === "audio_chunk").length >= 2,
      );
      check("turn_done closes the loop", events.at(-1)?.type === "turn_done");
    }

    console.log("case: mixed voice + typed text in one request");
    {
      const { status, events } = await chat(BASE, {
        model: "openai/gpt-audio",
        audio: { data: makeWavBase64(0.5), format: "wav" },
        text: "and also read this typed note",
      });
      check("mixed turn -> 200", status === 200);
      check("mixed turn still transcribes audio", events.some((event) => event.type === "user_transcript"));
    }

    console.log("case: upstream errors surface as 502");
    {
      const { status, json } = await chat(BASE, { text: "please trigger error now" });
      check("upstream 500 -> app 502", status === 502, `got ${status}`);
      check("error detail passes through", typeof json?.error === "string" && json.error.includes("Mock upstream exploded"), JSON.stringify(json));
    }

    console.log("case: oversized audio is rejected before upstream");
    {
      // 28 MiB of base64 decodes well past the 20 MiB per-turn cap.
      const big = "A".repeat(28 * 1024 * 1024);
      const { status } = await chat(BASE, { audio: { data: big, format: "wav" } });
      check("oversized audio -> 400", status === 400, `got ${status}`);
    }

    if (process.env.OPENROUTER_REAL_E2E === "1" && process.env.OPENROUTER_API_KEY) {
      console.log("case: LIVE OpenRouter — spawn a second app server against the real API");
      const liveApp = startProcess(
        "node",
        ["node_modules/.bin/next", "start", "-p", String(LIVE_PORT)],
        {
          // No OPENROUTER_BASE_URL override: this server talks to the real API.
          OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
          OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || "openai/gpt-audio",
        },
      );
      const liveUp = await waitHealthy(LIVE_BASE, 60000);
      check("live app server is up", liveUp);
      if (!liveUp) {
        console.error("live server failed to start; run with E2E_VERBOSE=1 for logs");
      } else {
        try {
          const models = (process.env.OPENROUTER_REAL_MODELS || "openai/gpt-audio,openai/gpt-audio-mini")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);

          for (const liveModel of models) {
            console.log(`case: LIVE typed turn on ${liveModel}`);
            const { status, events } = await chat(LIVE_BASE, {
              model: liveModel,
              text: "Reply with a one-sentence greeting.",
            });
            const joined = events
              .filter((event) => event.type === "delta")
              .map((event) => event.text)
              .join("");
            const chunks = events.filter((event) => event.type === "audio_chunk");
            check(`${liveModel}: stream -> 200 SSE`, status === 200, `got ${status}`);
            check(`${liveModel}: reply text streams`, joined.trim().length > 0, JSON.stringify(joined.slice(0, 80)));
            check(`${liveModel}: spoken reply audio streams`, chunks.length >= 1, `got ${chunks.length}`);
            check(
              `${liveModel}: spoken reply is decodable`,
              chunks.every((event) => {
                try {
                  return Buffer.from(event.data, "base64").length > 0 && event.sampleRate === 24000;
                } catch {
                  return false;
                }
              }),
            );
          }

          console.log("case: LIVE voice turn (real speech fixture through the app route)");
          const fixturePath = "/tmp/voice-session-e2e-mic.wav";
          const { stdout } = await execFileAsync("node", [
            "scripts/make-mic-fixture.mjs",
            "--out",
            fixturePath,
          ]);
          const fixture = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
          check("fixture synthesized (genuine speech)", Boolean(fixture.path) && fixture.bytes > 1000, JSON.stringify(fixture));
          const wavBase64 = (await (await import("node:fs/promises")).readFile(fixturePath)).toString("base64");
          const { status, events } = await chat(LIVE_BASE, {
            model: process.env.OPENROUTER_MODEL || "openai/gpt-audio",
            audio: { data: wavBase64, format: "wav" },
          });
          const transcriptEvent = [...events]
            .reverse()
            .find((event) => event.type === "user_transcript");
          const joined = events
            .filter((event) => event.type === "delta")
            .map((event) => event.text)
            .join("");
          const chunks = events.filter((event) => event.type === "audio_chunk");
          const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
          check("live voice turn -> 200 SSE", status === 200, `got ${status}`);
          check(
            "live transcript matches the spoken fixture",
            typeof transcriptEvent?.text === "string" &&
              norm(transcriptEvent.text).includes(norm("voice turn test")),
            JSON.stringify(transcriptEvent?.text?.slice(0, 120)),
          );
          check("live reply text streams", joined.trim().length > 0, JSON.stringify(joined.slice(0, 120)));
          check("live spoken reply audio streams", chunks.length >= 1, `got ${chunks.length}`);
        } finally {
          liveApp.kill("SIGTERM");
        }
      }
    } else {
      console.log("case: LIVE OpenRouter leg skipped (set OPENROUTER_REAL_E2E=1)");
    }

    console.log(`\ne2e: ${passed} passed, ${failures.length} failed`);
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    app.kill("SIGTERM");
    mock.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error("e2e crashed:", error);
  process.exitCode = 1;
});