import { expect, test } from "bun:test";
import { maskBody, maskHeader, spans } from "./masks.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const id = "req_0164c263-e96d-46ab-8b45-01206f479f32";
const now = () => Math.floor(Date.now() / 1000);
const json = (s: string) => dec.decode(maskBody(enc.encode(s), "application/json"));
const sse = (s: string) => dec.decode(maskBody(enc.encode(s), "text/event-stream; charset=utf-8"));

test("only the protocol paths are masked, and bytes are kept exactly", () => {
  // Odd spacing and an escape survive: nothing is re-serialized.
  const body = `{"id" : "${id}","created":${now()},"choices":[{"message":{"content":"a\\u0041"}}]}`;
  expect(json(body)).toBe(
    `{"id" : "req_<id>","created":"<t>","choices":[{"message":{"content":"a\\u0041"}}]}`,
  );
});

test("nested content objects with id and created stay unmasked", () => {
  const body = JSON.stringify({
    id,
    content: [{ type: "tool_use", id: "toolu_1", input: { id, created: now(), message: { id } } }],
  });
  expect(json(body)).toBe(body.replace(`"id":"${id}"`, '"id":"req_<id>"'));
  const chunk = JSON.stringify({
    id,
    choices: [
      {
        delta: {
          tool_calls: [{ function: { arguments: JSON.stringify({ id, created: now() }) } }],
        },
      },
    ],
  });
  expect(json(chunk)).toBe(chunk.replace(`{"id":"${id}"`, '{"id":"req_<id>"'));
});

test("text containing a uuid or an RFC 3339 date stays unmasked", () => {
  const text = `see ${id} at 2026-11-08T14:00:00Z, uuid 0164c263-e96d-46ab-8b45-01206f479f32`;
  const body = JSON.stringify({ type: "message", content: [{ type: "text", text }] });
  expect(json(body)).toBe(body);
  const frame = `event: content_block_delta\ndata: ${JSON.stringify({ delta: { text } })}\n\n`;
  expect(sse(frame)).toBe(frame);
});

test("values of the wrong shape are left for the comparison to see", () => {
  const body = JSON.stringify({ id: "req_not-a-uuid", created: now() - 100_000 });
  expect(json(body)).toBe(body);
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
  expect(sse(frames)).toBe(
    `event: message_start\ndata: {"type":"message_start","message":{"id":"req_<id>","content":[]}}\n\n` +
      `: keepalive ${id}\n\n`,
  );
});

test("Responses ids at their paths keep the item index", () => {
  const frame = JSON.stringify({
    type: "response.output_item.added",
    item: { id: `msg_${id}_3`, content: [] },
    response: { id: `resp_${id}`, created_at: now(), output: [{ id: `msg_${id}_0` }] },
    item_id: `msg_${id}_3`,
  });
  expect(json(frame)).toBe(
    JSON.stringify({
      type: "response.output_item.added",
      item: { id: "msg_req_<id>_3", content: [] },
      response: { id: "resp_req_<id>", created_at: "<t>", output: [{ id: "msg_req_<id>_0" }] },
      item_id: "msg_req_<id>_3",
    }),
  );
});

test("the tokenizer refuses what is not JSON, which leaves the body as it is", () => {
  expect(spans(enc.encode("[DONE]"))).toBeNull();
  expect(sse("data: [DONE]\n\n")).toBe("data: [DONE]\n\n");
  expect(json("{bad")).toBe("{bad");
});
