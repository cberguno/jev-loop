# voice-session

A Next.js text-and-voice chat that streams **microphone audio** to an
**OpenRouter audio-capable model** (e.g. `openai/gpt-audio`, the current name of
GPT-4o Audio), renders **both sides of the conversation as live transcript
text**, and accepts **typed text alongside or instead of voice** — with a
conversation-history sidebar.

> Built as a standalone app from the explicit product requirements
> (mic capture → streaming to an OpenRouter audio model, live two-sided
> transcript, typed input, history sidebar, deployable).
>
> Note on audio transport: OpenRouter's chat-completions API does not offer a
> realtime inbound audio socket, so — exactly like the push-to-talk flows on
> commercial voice chat web apps — the app records the utterance while you hold
> the mic, streams it upstream as a `input_audio` content part on release, and
> streams the model's reply back as SSE deltas.

## Features

- 🎤 **Mic capture** — `getUserMedia` + `MediaRecorder` (Opus/WebM), with a live
  level meter; recordings are decoded and re-encoded client-side to
  16-bit PCM WAV, the format audio models accept.
- 🔊 **Voice turns** — audio is sent to `POST /api/chat`, which calls OpenRouter
  with `modalities: ["text"]` and `include: ["input_audio_transcription"]`, so
  the model both *hears you* and returns *what you said*.
- 💬 **Live transcript** — the user's speech appears live while speaking (Web
  Speech API, with the model's `input_audio_transcription` as the source of
  truth), and the model's reply streams token-by-token into the chat.
- ⌨️ **Typed input** — Enter sends text-only turns; if you type *while* using
  the mic, the text and audio are sent **together** in one user turn.
- 🗂 **Sidebar** — conversation history persisted in `localStorage`: create,
  resume, rename (double-click), delete; per-app model picker with suggestions.
- 🚀 **Deploy** — Vercel (`vercel.json`, GitHub Actions workflow), or Docker.

## Stack

- [Next.js 15](https://nextjs.org) (App Router, Node runtime for the API route)
- React 19, TypeScript (strict), plain CSS
- No database: history lives in the browser

```
browser                    /api/chat (route handler)        OpenRouter
────────                   ───────────────────────           ─────────
🎤 MediaRecorder ───┐
⌨️ textarea ─────────┼──► JSON {turns, text, audio} ───► fetch /chat/completions
                    │      build messages[]                 (stream: true)
live Speech ────────┤            │                              │
Recognition         │            ▼                              │
                    │      normalize SSE ◄──────────────────────┘
live transcript ◄───┴──── {user_transcript | delta | turn_done | error}
```

The server route streams `text/event-stream` back to the browser; the client
parses the same SSE framing both on the server (from OpenRouter) and in the
browser (from `/api/chat`) with one tiny parser (`lib/sse.ts`).

## Requirements

- Node.js **≥ 20.9** (built and tested on Node 24)
- An OpenRouter API key ([openrouter.ai](https://openrouter.ai))

## Getting started

```bash
npm install
export OPENROUTER_API_KEY=sk-or-...   # server-side only, never exposed to the client
npm run dev
```

Open http://localhost:3000, pick a model (settings block in the sidebar), hold
the mic button and speak, or type.

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | — | OpenRouter key; **required** for chat |
| `OPENROUTER_MODEL` | `openai/gpt-audio` | default model when none chosen in the UI |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | override for the mock/tests |
| `APP_ORIGIN` | `http://localhost:3000` | sent as `HTTP-Referer` attribution |

Model picker defaults to `openai/gpt-audio` (GPT-4o Audio was renamed on
OpenRouter); `openai/gpt-audio-mini`, Gemini, Voxtral, or any id can be typed.
**If your OpenRouter workspace guardrails block a model** you'll see the
upstream error verbatim in the chat — pick another model or ask your workspace
admin to allow it.

## Testing the core loop

```bash
npm test            # unit: WAV encoder + SSE parser (node:test)
npm run test:e2e   # production build + mock OpenRouter, real HTTP/SSE end to end
npm run test:browser # Playwright: real Chromium, fake mic, UI transcript + history
```

The e2e script starts the wire-format-faithful mock (`scripts/mock-openrouter.mjs`,
validating `input_audio`/base64/WAV payloads) and the built Next.js server, then
drives the exact requests the browser makes: typed turns, voice turns, mixed
voice+text, validation errors, upstream error propagation, and the 20 MiB audio
cap. Set `OPENROUTER_REAL_E2E=1` with a real key to add one live round-trip.

The browser suite launches Chromium with a deterministic fake microphone
(`--use-fake-device-for-media-stream`), so the full voice turn — capture,
MediaRecorder, WAV re-encode, upload, live transcript — is exercised
end-to-end on every run.

## Deploying

### Vercel (recommended)

```bash
npm i -g vercel
vercel            # link + preview deploy
vercel --prod     # production
vercel env add OPENROUTER_API_KEY production
```

Or import the repo in the Vercel dashboard — `vercel.json` pins the Next.js
framework preset. Pushes to `main` also deploy automatically through
`.github/workflows/deploy.yml` once the repository secrets `VERCEL_TOKEN`,
`VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` are set (the job skips cleanly when
they are absent). Set `OPENROUTER_API_KEY` as a Production environment variable.

### Docker

```bash
docker build -t voice-session .
docker run -p 3000:3000 -e OPENROUTER_API_KEY=sk-or-... voice-session
```

## Project layout

```
app/api/chat/route.ts    server route: OpenRouter wire format + SSE normalizer
app/page.tsx             orchestration: mic, transcript, composer, sidebar
app/globals.css          styles (dark theme, responsive)
components/              Sidebar, TranscriptPanel, Composer
hooks/useVoiceRecorder   getUserMedia + MediaRecorder + level meter + WAV encode
hooks/useSpeechRecognition  live user transcript (optional enhancement)
hooks/useConversations   localStorage history store
lib/wav.ts               mono 16-bit PCM WAV encoder (pure)
lib/sse.ts               shared SSE parser (pure)
scripts/mock-openrouter.mjs  wire-format-faithful mock upstream
scripts/e2e.mjs          end-to-end core-loop test
tests/unit/              node:test unit tests
tests/browser/           Playwright browser e2e (fake mic, live transcript)
playwright.config.ts     browser test configuration
```

## Notes & limitations

- Audio **input** transcription works on any OpenRouter model that accepts
  `input_audio`; the reply is requested as text (`modalities: ["text"]`) — this
  app renders a transcript, it does not play model speech out loud.
- Browsers without the Web Speech API still get the user transcript from the
  model itself (`input_audio_transcription`), just not word-by-word live.
- History is per-browser (`localStorage`); there is no sync or auth.
- Recordings are capped at 20 MiB per turn.