import { expect, test } from "bun:test";
import { collect, type StreamEvent } from "@omni/ir";
import { anthropicResponse, anthropicStream } from "../../src/egress/anthropic.ts";

async function* src(...events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

const TEXT: StreamEvent[] = [
  { type: "start", id: "msg_1", model: "claude-opus-4" },
  { type: "blockStart", index: 0, block: { type: "text" } },
  { type: "blockDelta", index: 0, delta: { type: "text", text: "Hi" } },
  { type: "blockEnd", index: 0 },
  {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4000, cacheWriteTokens: 120 },
  },
];

async function frames(g: AsyncGenerator<{ event: string; data: string }>) {
  const out = [];
  for await (const f of g) out.push({ event: f.event, data: JSON.parse(f.data) });
  return out;
}

test("emits the full anthropic sse sequence", async () => {
  const f = await frames(anthropicStream(src(...TEXT), "msg_1"));
  expect(f.map((x) => x.event)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  expect(f[0]?.data.message.id).toBe("msg_1");
  // message_start goes out before any usage is known, so it reports zero and
  // message_delta carries the real counts.
  expect(f[0]?.data.message.usage).toEqual({
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  expect(f[2]?.data.delta).toEqual({ type: "text_delta", text: "Hi" });
  expect(f[4]?.data.delta.stop_reason).toBe("end_turn");
  // A client that cannot see these cannot tell a cache hit from a cold prefix,
  // which is the whole signal caching exists to report.
  expect(f[4]?.data.usage).toEqual({
    input_tokens: 10,
    output_tokens: 2,
    cache_read_input_tokens: 4000,
    cache_creation_input_tokens: 120,
  });
});

test("renders tool use blocks with input_json_delta", async () => {
  const f = await frames(
    anthropicStream(
      src(
        { type: "blockStart", index: 0, block: { type: "toolUse", id: "tu", name: "f" } },
        { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"a":1}' } },
        { type: "blockEnd", index: 0 },
      ),
      "msg_1",
    ),
  );
  expect(f[0]?.data.content_block).toEqual({ type: "tool_use", id: "tu", name: "f", input: {} });
  expect(f[1]?.data.delta).toEqual({ type: "input_json_delta", partial_json: '{"a":1}' });
});

test("renders thinking deltas and signatures", async () => {
  const f = await frames(
    anthropicStream(
      src(
        { type: "blockStart", index: 0, block: { type: "thinking" } },
        { type: "blockDelta", index: 0, delta: { type: "thinking", text: "hm" } },
        { type: "blockDelta", index: 0, delta: { type: "thinkingSignature", signature: "s" } },
      ),
      "msg_1",
    ),
  );
  expect(f[1]?.data.delta).toEqual({ type: "thinking_delta", thinking: "hm" });
  expect(f[2]?.data.delta).toEqual({ type: "signature_delta", signature: "s" });
});

test("renders an error event as an anthropic error frame", async () => {
  const f = await frames(
    anthropicStream(
      src({ type: "error", code: "RATE_LIMIT", message: "slow", retryable: true }),
      "msg_1",
    ),
  );
  expect(f[0]?.event).toBe("error");
  expect(f[0]?.data.error).toEqual({ type: "rate_limit_error", message: "slow" });
});

test("builds a non-streaming response body", () => {
  const body = anthropicResponse(collect(TEXT), "msg_1") as Record<string, unknown>;
  expect(body.id).toBe("msg_1");
  expect(body.type).toBe("message");
  expect(body.role).toBe("assistant");
  expect(body.content).toEqual([{ type: "text", text: "Hi" }]);
  expect(body.stop_reason).toBe("end_turn");
  expect(body.usage).toEqual({
    input_tokens: 10,
    output_tokens: 2,
    cache_read_input_tokens: 4000,
    cache_creation_input_tokens: 120,
  });
});

test("renders collected tool use with parsed input", () => {
  const body = anthropicResponse(
    collect([
      { type: "blockStart", index: 0, block: { type: "toolUse", id: "tu", name: "f" } },
      { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"a":1}' } },
      { type: "blockEnd", index: 0 },
      {
        type: "end",
        stopReason: "toolUse",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]),
    "msg_1",
  ) as Record<string, unknown>;
  expect((body.content as unknown[])[0]).toEqual({
    type: "tool_use",
    id: "tu",
    name: "f",
    input: { a: 1 },
  });
  expect(body.stop_reason).toBe("tool_use");
});
