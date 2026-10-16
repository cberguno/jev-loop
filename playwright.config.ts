import { defineConfig } from "@playwright/test";

/**
 * Browser e2e for the voice-session app.
 * `npm run test:browser` runs this against the production build with the
 * wire-format mock as upstream (scripts/mock-openrouter.mjs).
 */
export default defineConfig({
  testDir: "tests/browser",
  timeout: 120_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3101",
    launchOptions: {
      // Deterministic microphone: a fake audio input device with auto-grant,
      // so MediaRecorder captures real PCM and getUserMedia never prompts.
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  reporter: [["list"]],
});