import { SseParser, tryParseJson } from "@/lib/sse";
import {
  DEFAULT_MODEL,
  DEFAULT_OPENROUTER_BASE_URL,
  MAX_AUDIO_BYTES,
  MAX_CONTEXT_TURNS,
  OPENROUTER_KEY_ENV,
  OPENROUTER_MODEL_ENV,
  OPENROUTER_URL_ENV,
  type ChatEvent,
  type ChatRequestBody,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUDIO_TURN_PROMPT =
  "Transcribe the attached speech accurately, then reply to it conversationally.";

interface UpstreamDelta {
  content?: unknown;
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

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

interface UpstreamMessage {
  role: string;
  content: string | ContentPart[];
}

function buildMessages(body: ChatRequestBody): UpstreamMessage[] {
  const history: UpstreamMessage[] = (body.turns ?? [])
    .slice(-MAX_CONTEXT_TURNS)
    .map((turn) => ({
      role: turn.role,
      content: turn.text,
    }));
  const parts: ContentPart[] = [];
  if (body.audio) {
    parts.push({ type: "input_audio", input_audio: body.audio });
  }
  if (body.text) {
    parts.push({ type: "text", text: body.text });
  } else {
    parts.push({ type: "text", text: AUDIO_TURN_PROMPT });
  }
  history.push({ role: "user", content: parts });
  return history;
}

function upstreamEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/chat/completions`;
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

  const model = body.model?.trim() || process.env[OPENROUTER_MODEL_ENV]?.trim() || DEFAULT_MODEL;
  const baseUrl = process.env[OPENROUTER_URL_ENV]?.trim() || DEFAULT_OPENROUTER_BASE_URL;
  const origin = process.env.APP_ORIGIN?.trim() || "http://localhost:3000";

  const upstream = await fetch(upstreamEndpoint(baseUrl), {
    method: "POST",
    signal: request.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": origin,
      "X-Title": "voice-session",
    },
    body: JSON.stringify({
      model,
      stream: true,
      modalities: ["text"],
      // Ask audio models to return what the user said (input transcription).
      include: body.audio ? ["input_audio_transcription"] : undefined,
      messages: buildMessages(body),
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    let message = `Upstream ${upstream.status}`;
    try {
      const parsed = tryParseJson(detail) as { error?: { message?: string } } | null;
      message = parsed?.error?.message ?? (detail.slice(0, 400) || message);
    } catch {
      message = detail.slice(0, 400) || message;
    }
    return Response.json({ error: message }, { status: 502 });
  }

  const parser = new SseParser();
  const encoder = new TextEncoder();
  let modelSeen: string | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const sse of parser.feed(decoder.decode(value, { stream: true }))) {
            if (sse.data === "[DONE]") {
              emit({ type: "turn_done", finishReason: "stop", model: modelSeen });
              continue;
            }
            const chunk = tryParseJson(sse.data) as UpstreamChunk | null;
            if (!chunk) continue;
            if (typeof chunk.model === "string") modelSeen = chunk.model;
            const inner = chunk.error?.message;
            if (inner) {
              emit({ type: "error", message: inner });
              continue;
            }
            const choice = chunk.choices?.[0];
            const delta = choice?.delta;
            if (!delta) continue;
            const transcription = delta.input_audio_transcription?.text;
            if (typeof transcription === "string" && transcription.length > 0) {
              emit({ type: "user_transcript", text: transcription });
            }
            if (typeof delta.content === "string" && delta.content.length > 0) {
              emit({ type: "delta", text: delta.content });
            }
          }
        }
        emit({ type: "turn_done", finishReason: "stop", model: modelSeen });
      } catch (error) {
        emit({ type: "error", message: (error as Error).message });
      } finally {
        try {
          controller.close();
        } catch {
          // client already went away
        }
      }
    },
    cancel() {
      // Client aborted (or page closed): relay so OpenRouter stops billing.
      upstream.body?.cancel().catch(() => undefined);
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}