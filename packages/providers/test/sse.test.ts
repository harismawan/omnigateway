import { expect, test } from "bun:test";
import { parseSse } from "../src/sse.ts";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

async function drain(s: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const m of parseSse(s)) out.push(m);
  return out;
}

test("parses event and data pairs", async () => {
  const msgs = await drain(
    streamOf('event: message_start\ndata: {"a":1}\n\nevent: ping\ndata: {}\n\n'),
  );
  expect(msgs).toEqual([
    { event: "message_start", data: '{"a":1}' },
    { event: "ping", data: "{}" },
  ]);
});

test("handles messages split across chunk boundaries", async () => {
  const msgs = await drain(streamOf("event: msg\nda", 'ta: {"x":', "2}\n\n"));
  expect(msgs).toEqual([{ event: "msg", data: '{"x":2}' }]);
});

test("defaults the event name to 'message' when absent", async () => {
  expect(await drain(streamOf("data: hello\n\n"))).toEqual([{ event: "message", data: "hello" }]);
});

test("joins multi-line data with newlines", async () => {
  expect(await drain(streamOf("data: line1\ndata: line2\n\n"))).toEqual([
    { event: "message", data: "line1\nline2" },
  ]);
});

test("ignores comment lines used as heartbeats", async () => {
  expect(await drain(streamOf(": keep-alive\n\ndata: real\n\n"))).toEqual([
    { event: "message", data: "real" },
  ]);
});

test("tolerates CRLF line endings", async () => {
  expect(await drain(streamOf("event: e\r\ndata: d\r\n\r\n"))).toEqual([{ event: "e", data: "d" }]);
});

test("emits a trailing message with no terminating blank line", async () => {
  expect(await drain(streamOf("data: last"))).toEqual([{ event: "message", data: "last" }]);
});

// Nothing rewrites bytes any more, so a record boundary has to be recognised in
// every spelling it can arrive in. `\n\r\n` is the one a reader is least likely
// to think of: it is what `\r\n\r\n` looks like from the first `\n` onwards, and
// it is also a real mixed-ending stream on its own.
test("recognises a blank line in every CRLF/LF spelling", async () => {
  const cases: Array<[string, string]> = [
    ["\n\n", "LF LF"],
    ["\r\n\r\n", "CRLF CRLF"],
    ["\n\r\n", "LF CRLF"],
    ["\r\n\n", "CRLF LF"],
  ];
  for (const [sep, label] of cases) {
    // Two records, so the separator is consumed rather than merely tolerated at
    // the end of the stream where the tail path would have caught it anyway.
    const stream = `data: one${sep}data: two${sep}`;
    expect(await drain(streamOf(stream)), label).toEqual([
      { event: "message", data: "one" },
      { event: "message", data: "two" },
    ]);
  }
});

test("splitting a CRLF record at any single point parses it identically", async () => {
  const whole = 'event: message_start\r\ndata: {"a":1}\r\n\r\nevent: ping\r\ndata: {}\r\n\r\n';
  const expected = [
    { event: "message_start", data: '{"a":1}' },
    { event: "ping", data: "{}" },
  ];
  expect(await drain(streamOf(whole))).toEqual(expected);
  for (let cut = 1; cut < whole.length; cut++) {
    expect(await drain(streamOf(whole.slice(0, cut), whole.slice(cut)))).toEqual(expected);
  }
});

// Two cuts, not one. The parser holds two characters back between chunks, so the
// arrangement that can defeat it is a separator spread over *three* segments —
// which a single cut cannot produce. Every earlier version of this file stopped
// at one cut, and the mutant that survived review lived in exactly this gap.
test("splitting a CRLF record at any two points parses it identically", async () => {
  const whole = "data: one\r\n\r\ndata: two\r\n\r\n";
  const expected = [
    { event: "message", data: "one" },
    { event: "message", data: "two" },
  ];
  for (let a = 1; a < whole.length; a++) {
    for (let b = a + 1; b < whole.length; b++) {
      const chunks = [whole.slice(0, a), whole.slice(a, b), whole.slice(b)];
      expect(await drain(streamOf(...chunks)), `cuts ${a},${b}`).toEqual(expected);
    }
  }
});

// A `\r` that is not a line ending is ordinary data and must survive the
// hold-back and re-join, rather than being dropped or moved.
test("keeps a bare carriage return that is followed by ordinary text", async () => {
  expect(await drain(streamOf("data: a\r", "b\n\n"))).toEqual([{ event: "message", data: "a\rb" }]);
  expect(await drain(streamOf("data: a\r", "b", "c\n\n"))).toEqual([
    { event: "message", data: "a\rbc" },
  ]);
});

/**
 * A `\r` ending the final line is a line terminator, so it is not data.
 *
 * This changed when normalization was removed. The old parser rewrote `\r\n`
 * and left a lone `\r` alone, so `data: a\r` at end of stream yielded `"a\r"`;
 * `parseRecord` now strips one trailing `\r` per line, which makes it `"a"`.
 * The SSE grammar terminates a line with CRLF, LF **or** CR, so the new answer
 * is the correct one — but it is a change, and it is pinned here rather than
 * left to be discovered.
 *
 * Bare CR remains unhandled *between* lines, exactly as before: `a\rb` inside a
 * record stays one line. That gap is unchanged by this commit.
 */
test("treats a carriage return ending the last line as a terminator, not data", async () => {
  expect(await drain(streamOf("data: a", "\r"))).toEqual([{ event: "message", data: "a" }]);
  expect(await drain(streamOf("data: a\r\n\r\n"))).toEqual([{ event: "message", data: "a" }]);
});

// The shape the rewrite exists for: one record arriving in many small pieces.
// Correctness only — the timing claim is in the design doc, and a timing
// assertion here would be a flake generator.
test("reassembles one large record delivered in many chunks", async () => {
  const payload = "x".repeat(50_000);
  const whole = `event: big\r\ndata: ${payload}\r\n\r\n`;
  const chunks: string[] = [];
  for (let at = 0; at < whole.length; at += 64) chunks.push(whole.slice(at, at + 64));
  expect(await drain(streamOf(...chunks))).toEqual([{ event: "big", data: payload }]);
});

// Every chunk boundary lands mid-separator somewhere in here, and the record
// content is deliberately shorter than the hold-back in places.
test("handles chunks shorter than the hold-back window", async () => {
  const whole = "data: a\r\n\r\ndata: b\n\n";
  const chunks = whole.split("");
  expect(await drain(streamOf(...chunks))).toEqual([
    { event: "message", data: "a" },
    { event: "message", data: "b" },
  ]);
});
