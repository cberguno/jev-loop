import test from "node:test";
import assert from "node:assert/strict";
import { SseParser, tryParseJson } from "../../lib/sse.ts";

test("SseParser splits payloads across arbitrary chunk boundaries", () => {
  const parser = new SseParser();
  const first = parser.feed('data: {"a":1}\n');
  assert.deepEqual(first, [{ data: '{"a":1}' }]);
  // One JSON payload split across two feeds.
  const part1 = parser.feed('data: {"b":');
  assert.deepEqual(part1, []);
  const part2 = parser.feed('2}\n\ndata: [DONE]\n\n');
  assert.deepEqual(part2, [{ data: '{"b":2}' }, { data: "[DONE]" }]);
});

test("SseParser ignores comments, blank lines, and event/id fields", () => {
  const parser = new SseParser();
  const events = parser.feed(": ping\n\nevent: delta\nid: 7\ndata: hello\n\n");
  assert.deepEqual(events, [{ data: "hello" }]);
});

test("SseParser handles CRLF and bare CR line endings", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.feed("data: one\r\n\r\ndata: two\r\r"), [{ data: "one" }, { data: "two" }]);
});

test("SseParser keeps an unterminated line buffered until finish", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.feed("data: tail"), []);
  assert.deepEqual(parser.finish(), [{ data: "tail" }]);
  assert.deepEqual(parser.finish(), []);
});

test("tryParseJson returns null instead of throwing", () => {
  assert.deepEqual(tryParseJson('{"ok":true}'), { ok: true });
  assert.equal(tryParseJson("not json"), null);
  assert.equal(tryParseJson("[DONE]"), null);
});