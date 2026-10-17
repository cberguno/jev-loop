import { SseParser, tryParseJson } from "@/lib/sse";
import {
  AUDIO_VOICE_ENV,
  DEFAULT_AUDIO_VOICE,
  DEFAULT_MODEL,
  DEFAULT_OPENROUTER_BASE_URL,
  MAX_AUDIO_BYTES,
  MAX_CONTEXT_TURNS,
  OPENROUTER_KEY_ENV,
  OPENROUTER_MODEL_ENV,
  OPENROUTER_URL_ENV,
  SPOKEN_REPLY_FORMAT,
  SPOKEN_REPLY_SAMPLE_RATE,
  type ChatEvent,
  type ChatRequestBody,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OpenRouter wire-format notes, verified live against openai/gpt-audio:
 *
 * - The provider only processes `input_audio` content when the request's
 *   `modalities` include "audio". With `modalities: ["text"]` alone the
 *   recording is silently dropped.
 * - Audio output requires `stream: true` and `audio.format: "pcm16"`
 *   (24 kHz mono for the gpt-audio family).
 * - The reply text for spoken turns arrives as `delta.audio.transcript`
 *   (not `delta.content`).
 * - `include: ["input_audio_transcription"]` is not forwarded by OpenRouter,
 *   so the user transcript comes from a dedicated ASR stage below.
 */

/**
 * Voice-turn prompt (marker protocol). Verified live: gpt-audio refuses
 * "output only the transcription" style prompts but follows this
 * conversational framing exactly:
 *
 *   TRANSCRIPT: <the user's exact words>\nREPLY: <conversational answer>
 */
const VOICE_TURN_PROMPT =
  "You can hear the attached recording. Begin your reply with 'TRANSCRIPT:' followed by my exact words, then a new line starting with 'REPLY:' followed by your conversational response to me.";

interface UpstreamDelta {
  content?: unknown;
  audio?: { transcript?: unknown; data?: unknown } | null;
  input_audio_transcription?: { text?: unknown } | null;
}

interface UpstreamChunk {
  choices?: { delta?: UpstreamDelta; finish_reason?: string | null }[];
  model?: string;
  error?: { message?: string } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Validate and normalize the request body; throws readable errors. */
function parseBody(raw: unknown): ChatRequestBody {
  if (!isRecord(raw)) {
    throw new Error("Body must be a JSON object.");
  }
  const text = asString(raw.text);
  const audio = raw.audio;
  const model = asString(raw.model);
  const turns = raw.turns;
  const history = (Array.isArray(turns) ? turns : [])
    .filter(isRecord)
    .map((turn) => ({
      role: turn.role === "assistant" ? ("assistant" as const) : ("user" as const),
      text: asString(turn.text) ?? "",
    }))
    .filter((turn) => turn.text.length > 0);
  if (!text && !isRecord(audio)) {
    throw new Error("Send `text`, `audio`, or both.");
  }
  if (isRecord(audio)) {
    const data = asString(audio.data);
    const format = asString(audio.format);
    if (!data || !format) {
      throw new Error("`audio` needs `data` (base64) and `format`.");
    }
    if (base64ByteLength(data) > MAX_AUDIO_BYTES) {
      throw new Error("Recording is too large; keep turns under 20 MiB.");
    }
    if (format !== "wav" && format !== "mp3" && format !== "opus" && format !== "aac") {
      throw new Error("`audio.format` must be one of wav, mp3, opus, aac.");
    }
    return { model, text, audio: { data, format }, turns: history };
  }
  return { model, text, audio: undefined, turns: history };
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

interface UpstreamMessage {
  role: string;
  content: string | ContentPart[];
}

function historyMessages(body: ChatRequestBody): UpstreamMessage[] {
  return (body.turns ?? [])
    .slice(-MAX_CONTEXT_TURNS)
    .map((turn) => ({ role: turn.role, content: turn.text }));
}

function upstreamEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function upstreamDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = tryParseJson(text) as { error?: { message?: string } } | null;
    return parsed?.error?.message ?? text.slice(0, 400) ?? `Upstream ${response.status}`;
  } catch {
    return text.slice(0, 400) || `Upstream ${response.status}`;
  }
}

/**
 * POST to OpenRouter with spoken-reply modality by default. Text-only models
 * (e.g. openrouter/auto routing) reject `modalities: ["text", "audio"]`; retry
 * once with plain text modality so they keep working.
 */
async function callUpstream(options: {
  baseUrl: string;
  apiKey: string;
  origin: string;
  model: string;
  messages: UpstreamMessage[];
  signal?: AbortSignal;
  spoken: boolean;
}): Promise<Response> {
  const endpoint = upstreamEndpoint(options.baseUrl);
  const headers = {
    Authorization: `Bearer ${options.apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": options.origin,
    "X-Title": "voice-session",
  };
  const send = (spoken: boolean) => {
    const payload: Record<string, unknown> = {
      model: options.model,
      stream: true,
      modalities: spoken ? ["text", "audio"] : ["text"],
      messages: options.messages,
    };
    if (spoken) {
      payload.audio = {
        voice: process.env[AUDIO_VOICE_ENV]?.trim() || DEFAULT_AUDIO_VOICE,
        format: SPOKEN_REPLY_FORMAT,
      };
    }
    return fetch(endpoint, {
      method: "POST",
      signal: options.signal,
      headers,
      body: JSON.stringify(payload),
    });
  };

  let response = await send(options.spoken);
  if (response.ok) return response;
  let detail = await upstreamDetail(response);
  if (options.spoken && response.status === 400 && /modalit|audio/i.test(detail)) {
    response = await send(false);
    if (response.ok) return response;
    detail = await upstreamDetail(response);
  }
  throw new UpstreamError(detail, response.status);
}

interface UpstreamHandlers {
  onText: (text: string) => void;
  onInputTranscript: (text: string) => void;
  onAudioChunk: (base64: string) => void;
  onModel: (model: string) => void;
  onError: (message: string) => void;
}

/** Consume one upstream streaming response into normalized handlers. */
async function consumeUpstream(
  response: Response,
  handlers: UpstreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) {
    throw new UpstreamError("Upstream returned no body", 502);
  }
  const parser = new SseParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      return;
    }
    const { done, value } = await reader.read();
    if (done) break;
    for (const sse of parser.feed(decoder.decode(value, { stream: true }))) {
      if (sse.data === "[DONE]") continue;
      const chunk = tryParseJson(sse.data) as UpstreamChunk | null;
      if (!chunk) continue;
      if (typeof chunk.model === "string") handlers.onModel(chunk.model);
      const inner = chunk.error?.message;
      if (inner) {
        handlers.onError(inner);
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      const transcript = delta.input_audio_transcription?.text;
      if (typeof transcript === "string" && transcript.length > 0) {
        handlers.onInputTranscript(transcript);
      }
      const text = `${asString(delta.content) ?? ""}${asString(delta.audio?.transcript) ?? ""}`;
      if (text.length > 0) handlers.onText(text);
      const data = asString(delta.audio?.data);
      if (data && data.length > 0) handlers.onAudioChunk(data);
    }
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = parseBody(await request.json().catch(() => null));
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  const apiKey = process.env[OPENROUTER_KEY_ENV];
  if (!apiKey) {
    return Response.json(
      { error: `Set ${OPENROUTER_KEY_ENV} before chatting.` },
      { status: 503 },
    );
  }

  const model =
    body.model?.trim() ||
    process.env[OPENROUTER_MODEL_ENV]?.trim() ||
    DEFAULT_MODEL;
  const baseUrl = process.env[OPENROUTER_URL_ENV]?.trim() || DEFAULT_OPENROUTER_BASE_URL;
  const origin = process.env.APP_ORIGIN?.trim() || "http://localhost:3000";

  const call = (messages: UpstreamMessage[], spoken: boolean) =>
    callUpstream({ baseUrl, apiKey, origin, model, messages, signal: request.signal, spoken });

  // First upstream call happens before the stream starts so hard upstream
  // failures still surface as 4xx/5xx statuses (the stream itself can only
  // carry error events once it has begun).
  const voiceTurn = Boolean(body.audio);
  let firstResponse: Response;
  try {
    const messages: UpstreamMessage[] = [...historyMessages(body)];
    if (voiceTurn) {
      const parts: ContentPart[] = [{ type: "input_audio", input_audio: body.audio! }];
      const typed = body.text?.trim();
      parts.push({
        type: "text",
        text: typed
          ? `${VOICE_TURN_PROMPT} I also typed: ${typed}`
          : VOICE_TURN_PROMPT,
      });
      messages.push({ role: "user", content: parts });
    } else {
      messages.push({ role: "user", content: body.text ?? "" });
    }
    firstResponse = await call(messages, true);
  } catch (error) {
    if (error instanceof UpstreamError) {
      return Response.json(
        { error: `${error.status}: ${error.message}` },
        { status: 502 },
      );
    }
    return Response.json({ error: (error as Error).message }, { status: 502 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const emit = (event: ChatEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const fail = (message: string) => {
        emit({ type: "error", message });
      };

      let modelSeen: string | undefined;
      const noteModel = (upstreamModel: string) => {
        modelSeen = upstreamModel;
      };

      // Marker-protocol parser state (voice turns) / plain delta accumulation.
      let buffer = "";
      let emittedTranscript = 0;
      let emittedReply = 0;
      const forwardAudio = (base64: string) => {
        emit({
          type: "audio_chunk",
          data: base64,
          format: SPOKEN_REPLY_FORMAT,
          sampleRate: SPOKEN_REPLY_SAMPLE_RATE,
        });
      };
      const onText = (chunk: string) => {
        buffer += chunk;
        if (!voiceTurn) {
          const reply = buffer.replace(/^\s+/, "");
          if (reply.length > emittedReply) {
            emit({ type: "delta", text: reply.slice(emittedReply) });
            emittedReply = reply.length;
          }
          return;
        }
        const tIdx = buffer.indexOf("TRANSCRIPT:");
        const rIdx = buffer.indexOf("REPLY:");
        if (rIdx !== -1) {
          if (tIdx !== -1 && tIdx < rIdx) {
            const transcript = buffer.slice(tIdx + "TRANSCRIPT:".length, rIdx).trim();
            if (transcript.length > emittedTranscript) {
              emittedTranscript = transcript.length;
              emit({ type: "user_transcript", text: transcript });
            }
          }
          const reply = buffer.slice(rIdx + "REPLY:".length).replace(/^[ \t]*(?:\r?\n)?/, "");
          if (reply.length > emittedReply) {
            emit({ type: "delta", text: reply.slice(emittedReply) });
            emittedReply = reply.length;
          }
        } else if (tIdx !== -1) {
          // Transcript still streaming; hold back a trailing partial marker.
          let candidate = buffer.slice(tIdx + "TRANSCRIPT:".length);
          const lastBreak = candidate.lastIndexOf("\n");
          if (lastBreak !== -1) candidate = candidate.slice(0, lastBreak);
          const soFar = candidate.trim();
          if (soFar.length > emittedTranscript) {
            emittedTranscript = soFar.length;
            emit({ type: "user_transcript", text: soFar });
          }
        }
        // Before any marker appears, emit nothing: the pre-marker text is
        // expected to be the marker itself. If the model never uses the
        // protocol, the flush below falls back to plain reply text.
      };
      const flush = () => {
        if (voiceTurn && emittedReply === 0) {
          const reply = buffer.replace(/^\s+/, "");
          if (reply.length > 0) {
            emit({ type: "delta", text: reply.slice(0) });
            emittedReply = reply.length;
          }
        }
      };

      try {
        await consumeUpstream(
          firstResponse,
          {
            onText,
            onInputTranscript: (text) => {
              emit({ type: "user_transcript", text });
            },
            onAudioChunk: forwardAudio,
            onModel: noteModel,
            onError: fail,
          },
          request.signal,
        );
        flush();
        emit({ type: "turn_done", finishReason: "stop", model: modelSeen ?? model });
      } catch (error) {
        if (error instanceof UpstreamError) {
          emit({ type: "error", message: `${error.status}: ${error.message}` });
        } else if (!(error instanceof Error && error.name === "AbortError")) {
          emit({ type: "error", message: (error as Error).message });
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // client already went away
        }
      }
    },
    cancel() {
      // Client aborted: nothing extra to relay; upstream signals carry the
      // cancellation into callUpstream/consumeUpstream readers.
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}