import { test, expect, chromium } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);

/**
 * LIVE voice-turn verification against the real OpenRouter API.
 *
 * Skipped unless OPENROUTER_LIVE_E2E=1 and OPENROUTER_API_KEY are set, so the
 * default `npm run test:browser` (and CI) stays mock-only and free.
 *
 * The workspace has no human microphone (headless VM; PulseAudio exposes only a
 * null monitor). Instead, Chrome is launched with
 * --use-file-for-fake-audio-capture pointed at a WAV synthesized through the
 * live model itself (scripts/make-mic-fixture.mjs), so the ENTIRE path is real
 * and audio-bearing: capture (MediaRecorder) → WAV encode → upload
 * (input_audio) → live transcript → streamed spoken reply → playback.
 */
const LIVE = process.env.OPENROUTER_LIVE_E2E === "1" && Boolean(process.env.OPENROUTER_API_KEY);
test.skip(!LIVE, "set OPENROUTER_LIVE_E2E=1 (+ OPENROUTER_API_KEY) to run the live voice suite");

const APP_PORT = 3104;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-audio";
const ALT_MODEL = "openai/gpt-audio-mini";
const MIC_FIXTURE = "/tmp/voice-session-live-mic.wav";

let app: ChildProcess;

test.beforeAll(async () => {
  if (!LIVE) return;
  app = spawn("node", ["node_modules/.bin/next", "start", "-p", String(APP_PORT)], {
    // No OPENROUTER_BASE_URL override: real API. The server inherits the
    // process env, which carries OPENROUTER_API_KEY / OPENROUTER_MODEL.
    stdio: "ignore",
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(APP_BASE);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    await delay(300);
  }
});

test.afterAll(() => {
  app?.kill("SIGTERM");
});

async function launchVoiceBrowser(micPath: string) {
  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${micPath}`,
    ],
  });
  const context = await browser.newContext();
  await context.grantPermissions(["microphone"]);
  const page = await context.newPage();
  await page.goto(APP_BASE);
  await page.waitForTimeout(500);
  return { browser, context, page };
}

async function waitForReply(page: import("@playwright/test").Page): Promise<string> {
  const bubbles = page.locator(".bubble.theirs .bubble-text");
  await expect(bubbles.last()).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      async () => ((await bubbles.last().textContent()) ?? "").trim(),
      { timeout: 60_000 },
    )
    .toBeTruthy();
  return (await bubbles.last().textContent()) ?? "";
}

test("genuine voice turn: capture → encode → upload → transcript → spoken reply", async () => {
  // Synthesize genuine speech through the live model to stand in for the
  // (physically absent) human microphone.
  const { stdout } = await execFileAsync("node", [
    "scripts/make-mic-fixture.mjs",
    "--out",
    MIC_FIXTURE,
  ]);
  const fixture = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
    transcript: string;
    seconds: number;
  };
  expect(fixture.transcript.length, "fixture should carry a transcript").toBeGreaterThan(0);

  const { browser, page } = await launchVoiceBrowser(MIC_FIXTURE);

  // Capture what the browser actually uploads (encode + upload proof).
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/chat")) {
      uploads.push(request.postData() ?? "");
    }
  });

  try {
    // Hold the mic for the full fixture duration (+ slack): the fake device
    // feeds the synthesized speech through the real capture path.
    const mic = page.locator(".mic-button");
    await mic.dispatchEvent("pointerdown");
    await expect(page.locator(".bubble.live")).toBeVisible();
    await page.waitForTimeout(fixture.seconds * 1000 + 1500);
    await mic.dispatchEvent("pointerup");

    // Upload proof: the request carried a RIFF/WAV input_audio payload.
    await expect
      .poll(async () => uploads.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
    const payload = JSON.parse(uploads[0] ?? "{}");
    const audio = payload.audio as { data?: string; format?: string } | undefined;
    expect(audio?.format).toBe("wav");
    const bytes = Buffer.from(audio?.data ?? "", "base64");
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(bytes.length).toBeGreaterThan(fixture.transcript.length); // real audio, not empty

    // Transcript proof: the user bubble shows what was spoken (live ASR
    // through the model; normalized comparison, punctuation-tolerant).
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    await expect
      .poll(
        async () =>
          norm((await page.locator(".bubble.mine .bubble-text").last().textContent()) ?? ""),
        { timeout: 90_000 },
      )
    .toContain(norm("voice turn test"));

    // Spoken reply proof: streamed reply text + audio playback indicator.
    await waitForReply(page);
    await expect(page.locator(".speaker-indicator")).toBeVisible({ timeout: 30_000 });

    await page.screenshot({ path: "/tmp/voice-session-live-turn.png" });
  } finally {
    await browser.close();
  }
});

test("mini stays available as the sidebar alternate and answers live", async () => {
  const { browser, page } = await launchVoiceBrowser(MIC_FIXTURE);
  try {
    await page.locator("#model-select").selectOption(ALT_MODEL);
    await expect(page.locator(".topbar-model")).toHaveText(ALT_MODEL);
    await page
      .getByPlaceholder("Type a message, or hold 🎤 to speak")
      .fill("Reply with a one-sentence greeting.");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForReply(page);
    await expect(page.locator(".speaker-indicator")).toBeVisible({ timeout: 30_000 });
  } finally {
    await browser.close();
  }
});

test("typed-only turn against the live model still gets a spoken reply", async () => {
  const { browser, page } = await launchVoiceBrowser(MIC_FIXTURE);
  try {
    await page
      .getByPlaceholder("Type a message, or hold 🎤 to speak")
      .fill("Say hello and confirm you can read typed text.");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForReply(page);
    await expect(page.locator(".speaker-indicator")).toBeVisible({ timeout: 30_000 });
  } finally {
    await browser.close();
  }
});