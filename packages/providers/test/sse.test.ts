import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { MAX_RECORD_CHARS, parseSse, type SseMessage } from "../src/sse.ts";

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

// ---------------------------------------------------------------------------
// The incomplete-record cap
// ---------------------------------------------------------------------------

/**
 * An upstream that never sends a blank line must not decide how much memory the
 * gateway commits.
 *
 * The parser is linear now, so it will happily assemble a record for as long as
 * bytes keep arriving — which turns a broken or hostile upstream into an
 * out-of-memory kill rather than a failed request. Last open item of
 * `docs/2026-08-08-engineering-audit.md:350-352`.
 */
test("refuses a record that grows past the cap without a separator", async () => {
  // Delivered in pieces, so this is the accumulating path rather than one
  // oversized chunk. Sized off the constant rather than a literal: a cap raised
  // past a hardcoded total turns this into a test that never reaches the branch
  // it is named for, and says nothing while doing it.
  const piece = "x".repeat(1024 * 1024);
  const pieces = Math.ceil(MAX_RECORD_CHARS / piece.length) + 1;
  const chunks = ["data: ", ...Array.from({ length: pieces }, () => piece)];

  let thrown: unknown;
  try {
    await drain(streamOf(...chunks));
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(GatewayError);
  const error = thrown as GatewayError;
  expect(error.code).toBe("UPSTREAM");
  // Retryable, so a pool with another candidate gets to try one.
  expect(error.retryable).toBe(true);
  // Authored here, so an operator sees the reason without turning debug on.
  expect(error.gatewayAuthored).toBe(true);
  expect(error.message).toContain(String(MAX_RECORD_CHARS));
  // Nothing of the body reaches the message.
  expect(error.message).not.toContain("xxxx");
});

test("refuses an oversized record that arrives complete in one chunk", async () => {
  const huge = `data: ${"y".repeat(MAX_RECORD_CHARS + 10)}\n\n`;
  let thrown: unknown;
  try {
    await drain(streamOf(huge));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(GatewayError);
  expect((thrown as GatewayError).code).toBe("UPSTREAM");
});

/**
 * The cap is per record, and this is the test that says so.
 *
 * A counter that is never reset caps the *stream* instead, which breaks every
 * long conversation — the failure would look like a provider dying partway
 * through a normal answer, and only on the long ones.
 */
test("does not trip on a long stream whose total far exceeds the cap", async () => {
  const half = "z".repeat(64 * 1024);
  const body = half + half;
  // Enough records that a build which never resets the counter would clear the
  // cap, while no single record is anywhere near it.
  //
  // Sized against `half`, not `body`, and the difference is the whole test.
  // Only the *first* chunk of each record reaches `pendingChars`: the second
  // completes the record through the path that clears the accumulator instead
  // of adding to it. So a broken build accrues one half per record, and sizing
  // against the full body under-counts by two and leaves the mutant alive.
  // Measured — that is exactly what happened when the cap moved to 25 MiB.
  const records = Math.ceil(MAX_RECORD_CHARS / half.length) + 5;

  // **Each record is split across two chunks on purpose.** Written with one
  // record per chunk, the accumulator is empty every time a record completes,
  // so a build that never resets it still passes and the test proves nothing.
  // Measured: that version left the "counter never reset" mutant alive.
  const chunks: string[] = [];
  for (let i = 0; i < records; i++) {
    chunks.push(`data: ${half}`);
    chunks.push(`${half}\n\n`);
  }

  const msgs = await drain(streamOf(...chunks));
  expect(msgs).toHaveLength(records);
  expect(msgs[0]?.data).toBe(body);
  expect(msgs[records - 1]?.data).toBe(body);
});

test("accepts a record just under the cap", async () => {
  const body = "w".repeat(MAX_RECORD_CHARS - 100);
  expect(await drain(streamOf(`data: ${body}\n\n`))).toEqual([{ event: "message", data: body }]);
});

// Records already parsed before the offending one still reached the caller, so
// a stream that goes wrong late is not retroactively emptied.
test("yields the records that arrived before the oversized one", async () => {
  const piece = "q".repeat(1024 * 1024);
  const pieces = Math.ceil(MAX_RECORD_CHARS / piece.length) + 1;
  const chunks = ["data: first\n\ndata: ", ...Array.from({ length: pieces }, () => piece)];

  const seen: SseMessage[] = [];
  let thrown: unknown;
  try {
    for await (const msg of parseSse(streamOf(...chunks))) seen.push(msg);
  } catch (error) {
    thrown = error;
  }

  expect(seen).toEqual([{ event: "message", data: "first" }]);
  expect(thrown).toBeInstanceOf(GatewayError);
});
