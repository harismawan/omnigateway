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

// The buffer is normalized one appended segment at a time, so the only CRLF a
// scan of that segment cannot see is one whose halves land in different chunks.
// A fix that normalizes the segment and forgets to carry the trailing `\r`
// passes every test above and corrupts exactly these.
test("normalizes a CRLF split across a chunk boundary", async () => {
  expect(await drain(streamOf("event: e\r", "\ndata: d\r", "\n\r", "\n"))).toEqual([
    { event: "e", data: "d" },
  ]);
});

test("splitting a CRLF record anywhere parses it identically", async () => {
  const whole = 'event: message_start\r\ndata: {"a":1}\r\n\r\nevent: ping\r\ndata: {}\r\n\r\n';
  const expected = await drain(streamOf(whole));
  expect(expected).toEqual([
    { event: "message_start", data: '{"a":1}' },
    { event: "ping", data: "{}" },
  ]);
  for (let cut = 1; cut < whole.length; cut++) {
    expect(await drain(streamOf(whole.slice(0, cut), whole.slice(cut)))).toEqual(expected);
  }
});

// A `\r` that is not a line ending is ordinary data and must survive being held
// back and re-joined, rather than being dropped or moved.
test("keeps a bare carriage return that is followed by ordinary text", async () => {
  expect(await drain(streamOf("data: a\r", "b\n\n"))).toEqual([{ event: "message", data: "a\rb" }]);
});

test("keeps a bare carriage return at the very end of a stream", async () => {
  expect(await drain(streamOf("data: a", "\r"))).toEqual([{ event: "message", data: "a\r" }]);
});
