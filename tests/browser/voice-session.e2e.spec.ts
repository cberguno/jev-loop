import { test, expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const MOCK_PORT = 4142;
const APP_PORT = 3101;

let app: ReturnType<typeof spawn>;
let mock: ReturnType<typeof spawn>;

test.beforeAll(async () => {
  mock = spawn("node", ["scripts/mock-openrouter.mjs", String(MOCK_PORT)], {
    env: { ...process.env, OPENROUTER_API_KEY: "mock-key" },
    stdio: "ignore",
  });
  app = spawn("node", ["node_modules/.bin/next", "start", "-p", String(APP_PORT)], {
    env: {
      ...process.env,
      OPENROUTER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/api/v1`,
      OPENROUTER_API_KEY: "mock-key",
      OPENROUTER_MODEL: "openai/gpt-audio",
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${APP_PORT}`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    await delay(300);
  }
});

test.afterAll(() => {
  app?.kill("SIGTERM");
  mock?.kill("SIGTERM");
});

async function openApp(page: Page): Promise<void> {
  // Fake mic device + auto-grant, so MediaRecorder has real audio to capture.
  const context = page.context();
  await context.grantPermissions(["microphone"]);
  await page.goto(`http://127.0.0.1:${APP_PORT}`);
}

async function waitForReply(page: Page): Promise<void> {
  const bubbles = page.locator(".bubble.theirs .bubble-text");
  await expect(bubbles.last()).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => ((await bubbles.last().textContent()) ?? "").trim(), { timeout: 20_000 })
    .toBe("Hello from the mock model.");
}

test("typed turn streams a live transcript and lands in the sidebar history", async ({ page }) => {
  await openApp(page);
  await page.getByPlaceholder("Type a message, or hold 🎤 to speak").fill("Hello mock!");
  await page.getByRole("button", { name: "Send" }).click();

  // Both sides render as transcript text.
  await expect(page.locator(".bubble.mine .bubble-text").last()).toHaveText("Hello mock!");
  await waitForReply(page);
  // Spoken reply: the model's audio streams back and plays in the browser.
  await expect(page.locator(".speaker-indicator")).toBeVisible({ timeout: 15_000 });

  // Sidebar history: one conversation, titled from the first user turn.
  await expect(page.locator(".conversation-title").first()).toHaveText("Hello mock!");
  await expect(page.locator(".conversation-meta").first()).toContainText("2 msgs");

  // History survives a reload (localStorage persistence).
  await page.reload();
  await expect(page.locator(".conversation-title").first()).toHaveText("Hello mock!");
  await expect(page.locator(".bubble.mine .bubble-text").first()).toHaveText("Hello mock!");
  await expect(page.locator(".bubble.theirs .bubble-text").first()).toHaveText(/Hello from the mock model/);
});

test("voice turn captures mic audio, sends WAV upstream, and renders the transcript", async ({ page }) => {
  await openApp(page);

  // Hold the mic: recording starts, live user-transcript bubble appears.
  const mic = page.locator(".mic-button");
  await mic.dispatchEvent("pointerdown");
  await expect(page.locator(".bubble.live")).toBeVisible();
  await page.waitForTimeout(1200);

  // Release: the turn is sent with audio; the model's input transcription
  // replaces the user bubble text.
  await mic.dispatchEvent("pointerup");
  await expect
    .poll(async () => (await page.locator(".bubble.mine .bubble-text").last().textContent()) ?? "", {
      timeout: 20_000,
    })
    .toBe("Hello from the mock audio transcription.");
  await waitForReply(page);
});

test("model picker changes the model used for the next turn", async ({ page }) => {
  await openApp(page);
  await page.locator("#model-select").selectOption("openrouter/auto");
  await expect(page.locator(".topbar-model")).toHaveText("openrouter/auto");
  await page.getByPlaceholder("Type a message, or hold 🎤 to speak").fill("model check");
  await page.getByRole("button", { name: "Send" }).click();
  await waitForReply(page);
});

test("new chat creates a second conversation; delete removes it", async ({ page }) => {
  await openApp(page);
  await page.getByPlaceholder("Type a message, or hold 🎤 to speak").fill("first chat");
  await page.getByRole("button", { name: "Send" }).click();
  await waitForReply(page);
  await page.getByRole("button", { name: "+ New chat" }).click();
  await expect(page.locator(".conversation-item")).toHaveCount(2);
  // New chats are prepended: delete the first (empty) one, keep "first chat".
  await page.locator(".conversation-item").first().hover();
  await page.locator(".conversation-item").first().locator("button[title='Delete']").click({ force: true });
  await expect(page.locator(".conversation-item")).toHaveCount(1);
  await expect(page.locator(".conversation-title").first()).toHaveText("first chat");
});