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
- 🔊 **Voice turns** — audio is sent to `POST /api/chat` with the audio
  modality (required: with `modalities: ["text"]` alone the provider silently
  drops the recording). The model is asked to answer in a
  `TRANSCRIPT:` / `REPLY:` marker protocol, so one call yields both *what you
  said* and a conversational reply.
- 💬 **Live transcript, both sides** — your speech streams into your bubble
  (model transcription; Web Speech API adds word-by-word preview where
  available), and the model's reply streams token-by-token.
- 🔉 **Spoken replies** — gpt-audio streams pcm16 audio chunks (24 kHz) which
  the browser plays back gaplessly through Web Audio while the text streams in
  (`🔊 Model is speaking` indicator).
- ⌨️ **Typed input** — Enter sends text-only turns; if you type *while* using
  the mic, the text and audio are sent **together** in one user turn.
- 🗂 **Sidebar** — conversation history persisted in `localStorage`: create,
  resume, rename (double-click), delete; per-app model picker with suggestions
  (default `openai/gpt-audio`, alternate `openai/gpt-audio-mini`).
- 🚀 **Deploy** — Vercel (`vercel.json`, GitHub Actions workflow), or Docker.

## Stack

- [Next.js 15](https://nextjs.org) (App Router, Node runtime for the API route)
- React 19, TypeScript (strict), plain CSS
- No database: history lives in the browser

```
browser                       /api/chat (route handler)          OpenRouter
────────                      ───────────────────────            ─────────
🎤 MediaRecorder ───┐
⌨️ textarea ─────────┼──► JSON {turns, text, audio} ───► fetch /chat/completions
                    │       build messages[]                 modalities: [text, audio]
live Speech ────────┤            │                            audio: pcm16/24k
Recognition         │            ▼                                 │
                    │      marker protocol parser ◄────────────────┘
                    │       (TRANSCRIPT:… / REPLY:…)
live transcript ◄───┤            │
reply text     ◄───┤      {user_transcript | delta | audio_chunk | turn_done | error}
🔉 pcm16 chunks ────┘       (Web Audio gapless playback)
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
| `OPENROUTER_AUDIO_VOICE` | `alloy` | voice for spoken replies (gpt-audio) |
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
validating `input_audio`/base64/WAV payloads, the marker protocol, and pcm16
reply chunks) and the built Next.js server, then drives the exact requests the
browser makes: typed turns, voice turns, mixed voice+text, validation errors,
upstream error propagation, and the 20 MiB audio cap.

The browser suite launches Chromium with a deterministic fake microphone
(`--use-fake-device-for-media-stream`), so the full voice turn — capture,
MediaRecorder, WAV re-encode, upload, live transcript, spoken-reply playback —
is exercised end-to-end on every run.

### Live verification (spends real API credits)

```bash
export OPENROUTER_API_KEY=sk-or-...      # and OPENROUTER_MODEL=openai/gpt-audio
OPENROUTER_REAL_E2E=1 npm run test:e2e            # HTTP leg against the real API
OPENROUTER_LIVE_E2E=1 npm run test:browser:live  # full voice turn in real Chromium
```

The live e2e leg spawns a second app server bound to the *real* OpenRouter API
(no mock override) and exercises typed turns on both `openai/gpt-audio` and
`openai/gpt-audio-mini`, plus a live voice round using genuine speech
synthesized through the model itself (`scripts/make-mic-fixture.mjs`).

The live browser suite has no human microphone available (headless VM), so
Chromium is launched with `--use-file-for-fake-audio-capture` pointing at that
same genuine speech WAV: every stage is real and audio-bearing — capture
(`MediaRecorder`), encode (WAV, RIFF-verified in the upload), upload
(`input_audio`), transcript (matches the spoken fixture), and the streamed
spoken reply (pcm16 chunks, played back with a visible speaker indicator).

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
hooks/useSpokenReplies   gapless Web Audio playback of streamed pcm16 replies
hooks/useSpeechRecognition  live user transcript (optional enhancement)
hooks/useConversations   localStorage history store
lib/wav.ts               mono 16-bit PCM WAV encoder (pure)
lib/pcm.ts               pcm16 → float decoding for spoken-reply playback
lib/sse.ts               shared SSE parser (pure)
scripts/mock-openrouter.mjs  wire-format-faithful mock upstream
scripts/make-mic-fixture.mjs  synthesize a genuine speech WAV via the live model
scripts/e2e.mjs          end-to-end core-loop test (mock + optional live leg)
tests/unit/              node:test unit tests
tests/browser/           Playwright browser e2e (mock suite + live voice suite)
playwright.config.ts     browser test configuration
```

## Notes & limitations

- **OpenRouter wire quirks, verified live against `openai/gpt-audio`:**
  - The provider only processes `input_audio` when `modalities` includes
    `audio`; with `["text"]` alone the recording is silently dropped.
  - Audio output requires `stream: true` and `audio.format: "pcm16"`
    (24 kHz mono for the gpt-audio family); reply text then arrives as
    `delta.audio.transcript`.
  - `include: ["input_audio_transcription"]` is not forwarded by OpenRouter —
    hence the `TRANSCRIPT:`/`REPLY:` marker prompt the app uses for voice turns.
  - The model refuses "output only the transcription" style prompts but follows
    the conversational marker protocol reliably.
  - The model speaks the marker narration too ("TRANSCRIPT: ... REPLY: ...");
    a future refinement could split ASR and reply into two calls for cleaner
    reply audio, at the cost of an extra upstream round-trip.
- Browsers without the Web Speech API still get the user transcript from the
  model's transcription, just not word-by-word live while speaking.
- History is per-browser (`localStorage`); there is no sync or auth.
- Recordings are capped at 20 MiB per turn.