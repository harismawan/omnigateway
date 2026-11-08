import { expect, test } from "bun:test";
import { type Dialect, MissingPath, maskBody, maskHeader, spans } from "./masks.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const id = "req_0164c263-e96d-46ab-8b45-01206f479f32";
const now = () => Math.floor(Date.now() / 1000);
const json = (s: string, d: Dialect) => dec.decode(maskBody(enc.encode(s), "application/json", d));
const sse = (s: string, d: Dialect) =>
  dec.decode(maskBody(enc.encode(s), "text/event-stream; charset=utf-8", d));

test("only the protocol paths are masked, and bytes are kept exactly", () => {
  const body = `{"id" : "${id}","object":"chat.completion","created":${now()},"choices":[{"message":{"content":"a\\u0041"}}]}`;
  expect(json(body, "openai")).toBe(
    `{"id" : "req_<id>","object":"chat.completion","created":"<t>","choices":[{"message":{"content":"a\\u0041"}}]}`,
  );
});

test("a payload missing a required path throws with dialect, kind and path", () => {
  expect(() => json(`{"object":"chat.completion","id":"${id}"}`, "openai")).toThrow(
    new MissingPath("openai chat.completion: required path created is missing"),
  );
  expect(() => sse('data: {"type":"message_start","message":{}}\n\n', "anthropic")).toThrow(
    "anthropic message_start: required path message / id is missing",
  );
  expect(() =>
    sse('data: {"type":"response.output_text.delta","delta":"x"}\n\n', "responses"),
  ).toThrow("responses response.output_text.delta: required path item_id is missing");
  // Optional paths may be absent.
  expect(() =>
    json(`{"object":"response","id":"resp_${id}","created_at":${now()},"output":[]}`, "responses"),
  ).not.toThrow();
  // Kinds that carry no generated ids (errors) are compared unmasked.
  const err = '{"type":"error","error":{"type":"api_error","message":"x"}}';
  expect(json(err, "anthropic")).toBe(err);
});

test("a literal dotted key is not a path", () => {
  const body = `{"type":"message","id":"${id}","message.id":"${id}","content":[]}`;
  expect(json(body, "anthropic")).toBe(
    `{"type":"message","id":"req_<id>","message.id":"${id}","content":[]}`,
  );
});

test("output array element ids are masked at output[*].id only", () => {
  const item = `msg_${id}_0`;
  const body = JSON.stringify({
    id: `resp_${id}`,
    object: "response",
    created_at: now(),
    output: [{ id: item, content: [{ id: item }] }, { id: `fc_${id}_1` }],
    meta: { output: [{ id: item }] },
    output2: [{ id: item }],
  });
  expect(json(body, "responses")).toBe(
    JSON.stringify({
      id: "resp_req_<id>",
      object: "response",
      created_at: "<t>",
      output: [{ id: "msg_req_<id>_0", content: [{ id: item }] }, { id: "fc_req_<id>_1" }],
      meta: { output: [{ id: item }] },
      output2: [{ id: item }],
    }),
  );
  // An object (not an array) under `output` is not `output[*]`.
  const notArray = JSON.stringify({
    id: `resp_${id}`,
    object: "response",
    created_at: now(),
    output: { x: { id: item } },
  });
  expect(json(notArray, "responses")).toContain(`"id":"${item}"`);
});

test("escaped property names are decoded before matching", () => {
  const body = `{"\\u0074ype":"message","\\u0069d":"${id}","content":[]}`;
  expect(json(body, "anthropic")).toBe(
    `{"\\u0074ype":"message","\\u0069d":"req_<id>","content":[]}`,
  );
  // A surrogate pair in a key decodes too, and matches nothing.
  const pair = `{"type":"message","id":"${id}","\\ud83d\\ude00":"${id}"}`;
  expect(json(pair, "anthropic")).toBe(
    `{"type":"message","id":"req_<id>","\\ud83d\\ude00":"${id}"}`,
  );
  expect(spans(enc.encode('{"\\ud83d\\ude00":1}'))?.[0]?.path).toEqual(["\u{1f600}"]);
});

test("prototype-named keys neither crash nor mask", () => {
  for (const k of ["hasOwnProperty", "__proto__", "constructor", "toString"]) {
    for (const v of ["1", "{}", `"${id}"`]) {
      const body = `{"type":"${k}","${k}":${v},"id":"${id}"}`;
      expect(json(body, "anthropic")).toBe(body);
      const kindHit = `{"type":"message","id":"${id}","${k}":${v}}`;
      expect(json(kindHit, "anthropic")).toBe(kindHit.replace(id, "req_<id>"));
    }
  }
  expect(json(`{"object":"__proto__","id":"${id}"}`, "openai")).toBe(
    `{"object":"__proto__","id":"${id}"}`,
  );
});

test("nested content objects with id and created stay unmasked", () => {
  const body = JSON.stringify({
    id,
    type: "message",
    content: [{ type: "tool_use", id: "toolu_1", input: { id, created: now(), message: { id } } }],
  });
  expect(json(body, "anthropic")).toBe(body.replace(`"id":"${id}"`, '"id":"req_<id>"'));
  const chunk = JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: now(),
    choices: [
      {
        delta: {
          tool_calls: [{ function: { arguments: JSON.stringify({ id, created: now() }) } }],
        },
      },
    ],
  });
  expect(json(chunk, "openai")).toBe(
    chunk
      .replace(`{"id":"${id}"`, '{"id":"req_<id>"')
      .replace(/"created":\d+,"choices"/, '"created":"<t>","choices"'),
  );
});

test("text containing a uuid or an RFC 3339 date stays unmasked", () => {
  const text = `see ${id} at 2026-11-08T14:00:00Z, uuid 0164c263-e96d-46ab-8b45-01206f479f32`;
  const body = JSON.stringify({ type: "message", id, content: [{ type: "text", text }] });
  expect(json(body, "anthropic")).toBe(body.replace(`"id":"${id}"`, '"id":"req_<id>"'));
  const frame = `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text } })}\n\n`;
  expect(sse(frame, "anthropic")).toBe(frame);
});

test("values of the wrong shape are left for the comparison to see", () => {
  const body = JSON.stringify({
    object: "chat.completion",
    id: "req_not-a-uuid",
    created: now() - 100_000,
  });
  expect(json(body, "openai")).toBe(body);
  expect(maskHeader("retry-after", "9999")).toBe("9999");
  expect(maskHeader("x-ratelimit-reset-requests", "soon")).toBe("soon");
  expect(maskHeader("anthropic-ratelimit-requests-reset", "1999-01-01T00:00:00Z")).toBe(
    "1999-01-01T00:00:00Z",
  );
  expect(maskHeader("date", "Mon, 01 Jan 2001 00:00:00 GMT")).toBe("Mon, 01 Jan 2001 00:00:00 GMT");
});

test("SSE data payloads are masked frame by frame; comments are untouched", () => {
  const frames =
    `event: message_start\ndata: {"type":"message_start","message":{"id":"${id}","content":[]}}\n\n` +
    `: keepalive ${id}\n\n`;
  expect(sse(frames, "anthropic")).toBe(
    `event: message_start\ndata: {"type":"message_start","message":{"id":"req_<id>","content":[]}}\n\n` +
      `: keepalive ${id}\n\n`,
  );
});

test("Responses lifecycle and item frames mask their own paths", () => {
  const frame = JSON.stringify({
    type: "response.output_item.added",
    item: { id: `msg_${id}_3`, content: [] },
  });
  expect(json(frame, "responses")).toBe(
    JSON.stringify({
      type: "response.output_item.added",
      item: { id: "msg_req_<id>_3", content: [] },
    }),
  );
  const done = JSON.stringify({
    type: "response.completed",
    response: { id: `resp_${id}`, created_at: now(), output: [{ id: `msg_${id}_0` }] },
  });
  expect(json(done, "responses")).toBe(
    JSON.stringify({
      type: "response.completed",
      response: { id: "resp_req_<id>", created_at: "<t>", output: [{ id: "msg_req_<id>_0" }] },
    }),
  );
});

test("the tokenizer refuses what is not JSON, which leaves the body as it is", () => {
  expect(spans(enc.encode("[DONE]"))).toBeNull();
  expect(sse("data: [DONE]\n\n", "openai")).toBe("data: [DONE]\n\n");
  expect(json("{bad", "openai")).toBe("{bad");
});
