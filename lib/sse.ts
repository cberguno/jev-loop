/**
 * Incremental SSE parser shared by the server route (parsing OpenRouter
 * chunks) and the browser (parsing our normalized events), plus Node tests.
 *
 * Feeds text chunks in any split; yields complete `data:` payloads.
 */

export interface SseEvent {
  data: string;
}

export class SseParser {
  private buffer = "";

  /** Feed raw text; returns every complete `data:` payload found. */
  feed(text: string): SseEvent[] {
    this.buffer += text;
    const events: SseEvent[] = [];
    // Split on line endings (and tolerate \r\n / \n / \r).
    const lines = this.buffer.split(/\r\n|\n|\r/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trimStart();
      // `data: [DONE]` and friends are surfaced as plain events; callers
      // decide what the sentinel means.
      events.push({ data });
    }
    return events;
  }

  /** Flush any final unterminated line (real streams always end with \n,
   * so this only matters for tests and truncated streams). */
  finish(): SseEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    if (rest.trim().startsWith("data:")) {
      return [{ data: rest.trim().slice(5).trimStart() }];
    }
    return [];
  }
}

/** Parse one JSON payload defensively; returns null instead of throwing. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}