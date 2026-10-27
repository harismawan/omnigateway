import { expect, test } from "bun:test";
import type { HttpClient, HttpRequest, HttpResponse } from "@omni/providers";
import { createCaptureBudget } from "../src/bodies/budget.ts";
import {
  type BodyCollectorOptions,
  createBodyCollector,
  MAX_CAPTURED_BODY_BYTES,
} from "../src/bodyCapture.ts";

const encoder = new TextEncoder();

for (const cancellation of [false, true])
  test(`background settle bounds a ${cancellation ? "cancelled" : "stalled"} drain without leaking reservations`, async () => {
    const { collector, budget } = collectorWith();
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        source = controller;
      },
    });
    const response = await collector.wrap(async () => ({
      status: 200,
      headers: new Headers(),
      body: stream,
      text: async () => "",
    }))(wireRequest("request"));
    const reader = response.body?.getReader();
    source?.enqueue(encoder.encode("early"));
    await reader?.read();
    await Bun.sleep(0);
    const signal = new AbortController();
    const settling = collector.settle({
      signal: signal.signal,
      timeoutMs: cancellation ? 10000 : 5,
    });
    if (cancellation) signal.abort();
    await settling;
    const parts = collector.take(null);
    expect(parts.client.truncated).toBe(true);
    const held = budget.held();
    source?.enqueue(encoder.encode("late"));
    source?.close();
    await reader?.read();
    expect(budget.held()).toBe(held);
    expect(rawText(parts.attempts[0]?.response)).toBe("early");
    budget.release(parts.reservedBytes);
    expect(budget.held()).toBe(0);
  });

test("take transfers ownership only once, including while a drain is live", async () => {
  const { collector, budget } = collectorWith();
  collector.captureRequest("held");
  collector.frame("frame");
  const parts = collector.take(null);
  expect(() => collector.take(null)).toThrow("already taken");
  collector.captureResponse("late");
  collector.frame("late");
  expect(parts.client).toEqual({ request: "held", response: ["frame"], truncated: false });
  expect(budget.held()).toBe(parts.reservedBytes);
  budget.release(parts.reservedBytes);
  expect(budget.held()).toBe(0);
});

test("a live drain discards after handoff without changing returned chunks or reserving again", async () => {
  const { collector, budget } = collectorWith({ captureStreamChunks: true });
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      source = controller;
    },
  });
  const response = await collector.wrap(async () => ({
    status: 200,
    headers: new Headers(),
    body: stream,
    text: async () => "",
  }))(wireRequest("wire"));
  const reader = response.body?.getReader();
  source?.enqueue(encoder.encode("first"));
  await reader?.read();
  await Bun.sleep(0);
  const parts = collector.take(null);
  const held = budget.held();
  source?.enqueue(encoder.encode("later"));
  source?.close();
  await reader?.read();
  await collector.settle();
  expect(rawText(parts.attempts[0]?.response)).toBe("first");
  expect(parts.attempts[0]?.truncated).toBe(true);
  expect(budget.held()).toBe(held);
  budget.release(parts.reservedBytes);
  expect(budget.held()).toBe(0);
  expect(() => collector.take(null)).toThrow("already taken");
});
const rawText = (text: string | string[] | null | undefined): string =>
  Array.isArray(text) ? text.join("") : (text ?? "");
const bytesOf = (text: string | string[]): number => Buffer.byteLength(rawText(text));

function collectorWith(overrides: Partial<BodyCollectorOptions> = {}) {
  const budget = overrides.budget ?? createCaptureBudget(Number.MAX_SAFE_INTEGER);
  const dropped: string[] = [];
  const collector = createBodyCollector({
    captureStreamChunks: false,
    requestId: "req_1",
    at: 1_000,
    budget,
    onAbandoned: (reason) => dropped.push(reason),
    ...overrides,
  });
  return { collector, budget, dropped };
}

function wireRequest(body: string): HttpRequest {
  return {
    provider: "anthropic",
    url: "https://example.invalid/v1/messages",
    method: "POST",
    headers: [["Authorization", "Bearer never-captured"]],
    body,
    signal: new AbortController().signal,
  };
}

/** A response whose body is `chunks`, read through a pull source that records how far it got. */
function streamed(chunks: Uint8Array[]): { response: HttpResponse; pulled: () => number } {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[pulled];
      if (next === undefined) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(next);
    },
  });
  return {
    response: { status: 200, headers: new Headers(), body, text: async () => "" },
    pulled: () => pulled,
  };
}

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return "";
  return await new Response(stream).text();
}

// ---------------------------------------------------------------------------
// Raw text, never parsed trees
// ---------------------------------------------------------------------------

test("keeps the client request and response as the exact text, not a parsed copy", () => {
  const { collector } = collectorWith();
  // Whitespace and key order a parse-and-restringify would lose.
  const request = '{ "model" : "fast",\n  "messages": [] }';
  const response = '{"id":"req_1","content":[{"type":"text","text":"Hi"}]}';
  collector.captureRequest(request);
  collector.captureResponse(response);

  const parts = collector.take(null);
  expect(parts.client.request).toBe(request);
  expect(parts.client.response).toBe(response);
  expect(parts.client.truncated).toBe(false);
  expect(parts.requestId).toBe("req_1");
  expect(parts.at).toBe(1_000);
  expect(parts.abandoned).toBeNull();
});

test("keeps every wire request and response as raw text", async () => {
  const { collector } = collectorWith();
  const sent = '{"model":"claude-opus-4",  "stream":true}';
  const answer = 'event: message_start\ndata: {"type":"message_start"}\n\n';
  const http = collector.wrap(async () => streamed([encoder.encode(answer)]).response);

  expect(await readAll((await http(wireRequest(sent))).body)).toBe(answer);
  await collector.settle();

  const [attempt] = collector.take(null).attempts;
  expect(attempt?.request).toBe(sent);
  expect(rawText(attempt?.response)).toBe(answer);
  expect(attempt?.provider).toBe("anthropic");
  expect(attempt?.attempt).toBe(1);
});

test("a streamed client response is the list of frames the gateway wrote", () => {
  const { collector } = collectorWith();
  collector.frame("event: a\ndata: 1");
  collector.frame("event: b\ndata: 2");
  expect(collector.take(null).client.response).toEqual(["event: a\ndata: 1", "event: b\ndata: 2"]);
});

// ---------------------------------------------------------------------------
// Caps are UTF-8 bytes, 64 MiB per side
// ---------------------------------------------------------------------------

test("cuts a client request past the cap at a UTF-8 byte boundary, never mid-character", () => {
  const { collector } = collectorWith();
  // One ASCII byte, then two-byte characters: the cap falls inside one, so
  // the cut has to land a byte short. A code-unit cap keeps nearly twice the bytes.
  const text = `a${"é".repeat(MAX_CAPTURED_BODY_BYTES / 2 + 8)}`;
  collector.captureRequest(text);

  const parts = collector.take(null);
  const kept = parts.client.request ?? "";
  expect(bytesOf(kept)).toBe(MAX_CAPTURED_BODY_BYTES - 1);
  expect(text.startsWith(kept)).toBe(true);
  expect(parts.client.truncated).toBe(true);
});

test("a wire request exactly at the cap is whole; one byte more is cut and marked", async () => {
  const at = collectorWith();
  const exact = "x".repeat(MAX_CAPTURED_BODY_BYTES);
  await at.collector.wrap(async () => streamed([]).response)(wireRequest(exact));
  const whole = at.collector.take(null).attempts[0];
  expect(whole?.request?.length).toBe(MAX_CAPTURED_BODY_BYTES);
  expect(whole?.truncated).toBe(false);

  const over = collectorWith();
  // A three-byte character straddling the cap.
  const straddling = `${"x".repeat(MAX_CAPTURED_BODY_BYTES - 1)}€`;
  await over.collector.wrap(async () => streamed([]).response)(wireRequest(straddling));
  const cut = over.collector.take(null).attempts[0];
  expect(cut?.request).toBe("x".repeat(MAX_CAPTURED_BODY_BYTES - 1));
  expect(cut?.truncated).toBe(true);
});

test("drains a wire response past the cap, keeping exactly the cap in bytes", async () => {
  const { collector, budget } = collectorWith();
  const CHUNK = 1024 * 1024;
  // Odd-sized chunks of two-byte characters, so the cap falls mid-chunk and
  // mid-character at once.
  const piece = encoder.encode("é".repeat(CHUNK / 2 + 3));
  const count = Math.ceil((MAX_CAPTURED_BODY_BYTES * 1.25) / piece.byteLength);
  const source = streamed(Array.from({ length: count }, () => piece));
  const res = await collector.wrap(async () => source.response)(wireRequest("{}"));
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("expected a body");
  // The adapter stops after one chunk without cancelling.
  await reader.read();
  await collector.settle();

  // Read to the end — the pipe is never left full — and kept to the cap.
  expect(source.pulled()).toBe(count);
  const parts = collector.take(null);
  const attempt = parts.attempts[0];
  expect(attempt?.truncated).toBe(true);
  expect(bytesOf(attempt?.response ?? "")).toBeLessThanOrEqual(MAX_CAPTURED_BODY_BYTES);
  expect(bytesOf(attempt?.response ?? "")).toBeGreaterThan(MAX_CAPTURED_BODY_BYTES - 2);
  expect(rawText(attempt?.response).includes("\uFFFD")).toBe(false);
  // What is held is what was kept, not what was read.
  expect(parts.reservedBytes).toBe(budget.held());
  expect(parts.reservedBytes).toBeLessThanOrEqual(MAX_CAPTURED_BODY_BYTES + 2);
});

test("caps malformed decoded UTF-8 text rather than its smaller source bytes", async () => {
  const { collector, budget } = collectorWith();
  // Each invalid byte becomes a three-byte replacement character. The source
  // is below the cap, but its decoded text crosses it.
  const piece = new Uint8Array(1024 * 1024).fill(0xff);
  const count = Math.ceil(MAX_CAPTURED_BODY_BYTES / (piece.length * 3));
  const source = streamed(Array.from({ length: count }, () => piece));
  const res = await collector.wrap(async () => source.response)(wireRequest(""));
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("expected a body");
  await reader.read();
  await collector.settle();

  expect(source.pulled()).toBe(count);
  const parts = collector.take(null);
  const text = parts.attempts[0]?.response ?? "";
  expect(bytesOf(text)).toBe(MAX_CAPTURED_BODY_BYTES - 1);
  expect(rawText(text).endsWith("\uFFFD")).toBe(true);
  expect(parts.attempts[0]?.truncated).toBe(true);
  expect(parts.reservedBytes).toBe(bytesOf(text));
  expect(budget.held()).toBe(parts.reservedBytes);
  budget.release(parts.reservedBytes);
});

test("decoder flush cannot push retained text past the side cap", async () => {
  const { collector, budget } = collectorWith();
  const source = streamed([
    encoder.encode("x".repeat(MAX_CAPTURED_BODY_BYTES - 2)),
    new Uint8Array([0xe2, 0x82]),
  ]);
  const res = await collector.wrap(async () => source.response)(wireRequest(""));
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("expected a body");
  await reader.read();
  await collector.settle();

  const parts = collector.take(null);
  expect(bytesOf(parts.attempts[0]?.response ?? "")).toBe(MAX_CAPTURED_BODY_BYTES - 2);
  expect(rawText(parts.attempts[0]?.response).endsWith("x")).toBe(true);
  expect(parts.attempts[0]?.truncated).toBe(true);
  expect(parts.reservedBytes).toBe(MAX_CAPTURED_BODY_BYTES - 2);
  expect(budget.held()).toBe(parts.reservedBytes);
  budget.release(parts.reservedBytes);
});

test("a buffered wire response past the cap is cut in bytes and marked", async () => {
  const { collector } = collectorWith();
  const text = "ü".repeat(MAX_CAPTURED_BODY_BYTES / 2 + 1);
  const http: HttpClient = collector.wrap(async () => ({
    status: 500,
    headers: new Headers(),
    body: null,
    text: async () => text,
  }));
  // The adapter is handed the whole text; only the capture is cut.
  expect(await (await http(wireRequest("{}"))).text()).toBe(text);

  const attempt = collector.take(null).attempts[0];
  expect(bytesOf(attempt?.response ?? "")).toBe(MAX_CAPTURED_BODY_BYTES);
  expect(attempt?.truncated).toBe(true);
});

test("the frame sink evicts by bytes, keeping the most recent frames under the cap", () => {
  const { collector } = collectorWith();
  // Two-byte characters: four frames of 0.3 × cap characters are 0.6 × cap
  // bytes each, so only the last fits. Counting code units would keep three.
  const big = "ß".repeat(Math.floor(MAX_CAPTURED_BODY_BYTES * 0.3));
  for (let i = 0; i < 4; i++) collector.frame(`${i}:${big}`);

  const parts = collector.take(null);
  const frames = parts.client.response;
  if (!Array.isArray(frames)) throw new Error("expected frames");
  expect(frames.map((frame) => frame.slice(0, 2))).toEqual(["3:"]);
  expect(parts.client.truncated).toBe(true);
  // Evicted frames gave their bytes back.
  expect(parts.reservedBytes).toBe(bytesOf(frames[0] ?? ""));
});

test("the frame sink discards an oversized frame with explicit truncation and no reservation", () => {
  const { collector, budget } = collectorWith({
    budget: createCaptureBudget(MAX_CAPTURED_BODY_BYTES),
  });
  // Code units fit, UTF-8 bytes do not.
  const huge = `a${"é".repeat(MAX_CAPTURED_BODY_BYTES / 2)}`;
  collector.frame(huge);
  const parts = collector.take(null);
  expect(parts.client.response).toEqual([]);
  expect(parts.client.truncated).toBe(true);
  expect(parts.abandoned).toBeNull();
  expect(parts.reservedBytes).toBe(0);
  expect(budget.held()).toBe(0);
});

test("an exact-cap frame fits and subsequent terminal frames survive oversized frames", () => {
  const { collector, budget } = collectorWith();
  collector.frame("x".repeat(MAX_CAPTURED_BODY_BYTES));
  expect(budget.held()).toBe(MAX_CAPTURED_BODY_BYTES);
  collector.frame("y".repeat(MAX_CAPTURED_BODY_BYTES + 1));
  expect(budget.held()).toBeLessThanOrEqual(MAX_CAPTURED_BODY_BYTES);
  collector.frame("event: message_stop\ndata: {}");

  const parts = collector.take(null);
  expect(parts.client.response).toEqual(["event: message_stop\ndata: {}"]);
  expect(parts.client.truncated).toBe(true);
  expect(parts.reservedBytes).toBe(bytesOf("event: message_stop\ndata: {}"));
  expect(budget.held()).toBe(parts.reservedBytes);
  budget.release(parts.reservedBytes);
});

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

test.each([
  { name: "malformed bytes", chunks: [[0xff, 0xff, 0xff, 0xff]], text: "����", bytes: 12 },
  {
    name: "split code point",
    chunks: [
      [0xf0, 0x9f],
      [0x98, 0x80],
    ],
    text: "😀",
    bytes: 4,
  },
  { name: "split malformed sequence", chunks: [[0xe2], [0x28, 0xa1]], text: "�(�", bytes: 7 },
  { name: "incomplete final sequence", chunks: [[0xe2], [0x82]], text: "�", bytes: 3 },
])("reserves retained decoded text including $name", async ({ chunks, text, bytes }) => {
  const { collector, budget } = collectorWith({ budget: createCaptureBudget(bytes) });
  const source = streamed(chunks.map((chunk) => new Uint8Array(chunk)));
  const res = await collector.wrap(async () => source.response)(wireRequest(""));
  const adapterBytes = new Uint8Array(await new Response(res.body).arrayBuffer());
  await collector.settle();

  expect(adapterBytes).toEqual(new Uint8Array(chunks.flat()));
  const parts = collector.take(null);
  expect(parts.abandoned).toBeNull();
  expect(rawText(parts.attempts[0]?.response)).toBe(text);
  expect(parts.attempts[0]?.truncated).toBe(false);
  expect(parts.reservedBytes).toBe(bytes);
  expect(bytesOf(parts.attempts[0]?.response ?? "")).toBe(parts.reservedBytes);
  expect(budget.held()).toBe(bytes);
  budget.release(parts.reservedBytes);
  expect(budget.held()).toBe(0);
});

test("malformed UTF-8 budget refusal still drains without changing adapter bytes", async () => {
  const { collector, budget, dropped } = collectorWith({ budget: createCaptureBudget(8) });
  const chunks = [
    new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    encoder.encode("a"),
    encoder.encode("b"),
  ];
  const source = streamed(chunks);
  const res = await collector.wrap(async () => source.response)(wireRequest(""));
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("expected a body");
  const first = await reader.read();
  await collector.settle();

  expect(source.pulled()).toBe(3);
  expect(collector.abandoned).toBe("budget");
  expect(dropped).toEqual(["budget"]);
  expect(budget.held()).toBe(0);
  const received = [...(first.value ?? [])];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    received.push(...next.value);
  }
  expect(new Uint8Array(received)).toEqual(new Uint8Array(chunks.flatMap((chunk) => [...chunk])));
  const parts = collector.take(null);
  expect(parts.attempts[0]?.response).toBeNull();
  expect(parts.reservedBytes).toBe(0);
});

test("decoder flush reserves its replacement text or abandons at the budget", async () => {
  const { collector, budget, dropped } = collectorWith({ budget: createCaptureBudget(3) });
  const source = streamed([encoder.encode("a"), new Uint8Array([0xe2, 0x82])]);
  const res = await collector.wrap(async () => source.response)(wireRequest(""));
  expect(new Uint8Array(await new Response(res.body).arrayBuffer())).toEqual(
    new Uint8Array([0x61, 0xe2, 0x82]),
  );
  await collector.settle();

  const parts = collector.take(null);
  expect(parts.abandoned).toBe("budget");
  expect(parts.attempts[0]?.response).toBeNull();
  expect(parts.reservedBytes).toBe(0);
  expect(budget.held()).toBe(0);
  expect(dropped).toEqual(["budget"]);
});

test("reserves every kept byte against the budget as it arrives", async () => {
  const { collector, budget } = collectorWith({ captureStreamChunks: true });
  const request = '{"q":"héllo"}';
  collector.captureRequest(request);
  expect(budget.held()).toBe(bytesOf(request));

  const wire = '{"model":"m"}';
  const answer = "data: one\n\ndata: two\n\n";
  const http = collector.wrap(async () => streamed([encoder.encode(answer)]).response);
  await readAll((await http(wireRequest(wire))).body);
  await collector.settle();
  // Frames are derived in the worker, not duplicated on the main thread.
  expect(budget.held()).toBe(bytesOf(request) + bytesOf(wire) + bytesOf(answer));

  collector.frame("event: x\ndata: {}");
  collector.captureResponse("{}");
  const total = budget.held();
  const parts = collector.take(null);
  // The reservation moves to the parts: whoever writes them releases it.
  expect(parts.reservedBytes).toBe(total);
  expect(parts.attempts[0]?.captureStreamChunks).toBe(true);
});

test("replacing the client response gives back the bytes of the one it replaced", () => {
  const { collector, budget } = collectorWith();
  collector.captureResponse("x".repeat(100));
  collector.captureResponse("y".repeat(10));
  expect(budget.held()).toBe(10);
  expect(collector.take(null).client.response).toBe("y".repeat(10));
});

test("a reservation past the budget abandons the capture and frees what it held", async () => {
  const budget = createCaptureBudget(64 * 1024);
  const { collector, dropped } = collectorWith({ budget });
  collector.captureRequest("r".repeat(1024));

  const piece = encoder.encode("p".repeat(16 * 1024));
  const source = streamed(Array.from({ length: 64 }, () => piece));
  const res = await collector.wrap(async () => source.response)(wireRequest("w".repeat(512)));
  const adapter = await readAll(res.body);
  await collector.settle();

  // The adapter got every byte; the capture branch was drained to the end.
  expect(adapter.length).toBe(64 * piece.byteLength);
  expect(source.pulled()).toBe(64);
  expect(collector.abandoned).toBe("budget");
  expect(dropped).toEqual(["budget"]);
  expect(budget.held()).toBe(0);

  // Nothing further is stored or reserved once abandoned.
  collector.frame("event: late\ndata: {}");
  collector.captureResponse('{"late":true}');
  await collector.wrap(async () => streamed([piece]).response)(wireRequest("again"));
  expect(budget.held()).toBe(0);
  expect(dropped).toEqual(["budget"]);

  const parts = collector.take({ code: "UPSTREAM", status: 502 });
  expect(parts.abandoned).toBe("budget");
  expect(parts.reservedBytes).toBe(0);
  expect(parts.client.request).toBeNull();
  expect(parts.client.response).toBeNull();
  // The frame survives — which attempts went where — without any body.
  expect(parts.attempts.map((a) => [a.attempt, a.provider, a.request, a.response])).toEqual([
    [1, "anthropic", null, null],
    [2, "anthropic", null, null],
  ]);
  expect(parts.error).toEqual({ code: "UPSTREAM", status: 502 });
});

test("one collector abandoning leaves another's capture intact", () => {
  const budget = createCaptureBudget(100);
  const small = collectorWith({ budget });
  const large = collectorWith({ budget });
  small.collector.captureRequest("s".repeat(40));
  large.collector.captureRequest("l".repeat(61));

  expect(large.collector.abandoned).toBe("budget");
  expect(small.collector.abandoned).toBeNull();
  expect(budget.held()).toBe(40);
  expect(small.collector.take(null).client.request).toBe("s".repeat(40));
});

test("bytes arriving after the parts were taken are neither stored nor reserved", () => {
  const { collector, budget } = collectorWith();
  collector.captureRequest("abc");
  const parts = collector.take(null);
  collector.frame("late");
  expect(budget.held()).toBe(3);
  expect(parts.reservedBytes).toBe(3);
  expect(parts.client.response).toBeNull();
});
