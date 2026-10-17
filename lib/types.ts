/** Shared types for the voice-session app. */

export type Role = "user" | "assistant";

export type MessageStatus = "streaming" | "done" | "error";

export interface Message {
  id: string;
  role: Role;
  /** Final (or so-far accumulated) text. */
  text: string;
  status: MessageStatus;
  createdAt: number;
  /** How this user turn was produced. */
  source?: "typed" | "voice" | "mixed";
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  messages: Message[];
}

/** Normalized SSE events emitted by `POST /api/chat`. */
export type ChatEvent =
  | { type: "user_transcript"; text: string }
  | { type: "delta"; text: string }
  | { type: "audio_chunk"; data: string; format: "pcm16"; sampleRate: number }
  | { type: "turn_done"; finishReason?: string; model?: string }
  | { type: "error"; message: string };

/** Body accepted by `POST /api/chat`. */
export interface ChatRequestBody {
  /** Model identifier; overrides server default. */
  model?: string;
  /** Prior turns (text only) for context. */
  turns?: { role: Role; text: string }[];
  /** Typed text for this user turn. */
  text?: string;
  /** Base64 WAV audio for this user turn. */
  audio?: { data: string; format: "wav" | "mp3" | "opus" | "aac" };
}

/** Where to send a chat completion request. */
export const OPENROUTER_URL_ENV = "OPENROUTER_BASE_URL";
export const OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";
export const OPENROUTER_MODEL_ENV = "OPENROUTER_MODEL";
export const AUDIO_VOICE_ENV = "OPENROUTER_AUDIO_VOICE";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** GPT-4o Audio was renamed to `openai/gpt-audio` on OpenRouter. */
export const DEFAULT_MODEL = "openai/gpt-audio";

/** Voice for spoken replies (gpt-audio family). */
export const DEFAULT_AUDIO_VOICE = "alloy";
/** gpt-audio streaming audio output: 16-bit PCM at 24 kHz (verified live). */
export const SPOKEN_REPLY_FORMAT = "pcm16";
export const SPOKEN_REPLY_SAMPLE_RATE = 24000;

/** Models offered in the settings picker (any id can be typed instead). */
export const MODEL_SUGGESTIONS = [
  { id: "openai/gpt-audio", label: "GPT-4o Audio (openai/gpt-audio)" },
  { id: "openai/gpt-audio-mini", label: "GPT-4o mini Audio (openai/gpt-audio-mini)" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash (google/gemini-2.5-flash)" },
  { id: "mistralai/voxtral-small-24b-2507", label: "Voxtral Small (mistralai/voxtral-small-24b-2507)" },
  { id: "openrouter/auto", label: "OpenRouter Auto (text fallback, openrouter/auto)" },
] as const;

export const MAX_CONTEXT_TURNS = 20;
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;