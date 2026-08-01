import { expect, test } from "bun:test";
import type { ChatRequest, StreamEvent } from "@omni/ir";
import { decodeResponses } from "../src/openai/decode.ts";
import { toResponsesWire } from "../src/openai/wire.ts";
import type { SseMessage } from "../src/sse.ts";

const base: ChatRequest = {
  model: "smart",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

async function* msgs(...m: SseMessage[]): AsyncGenerator<SseMessage> {
  for (const x of m) yield x;
}

async function collect(g: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
}

test("maps messages onto responses input items", () => {
  const { body } = toResponsesWire(base, "gpt-5");
  expect(body.model).toBe("gpt-5");
  expect(body.input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  ]);
  expect(body.stream).toBe(true);
});

test("uses output_text for assistant content", () => {
  const { body } = toResponsesWire(
    { ...base, messages: [{ role: "assistant", content: [{ type: "text", text: "yo" }] }] },
    "gpt-5",
  );
  expect(body.input[0]).toEqual({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "yo" }],
  });
});

test("maps the system prompt onto instructions", () => {
  const { body } = toResponsesWire(
    { ...base, system: [{ type: "text", text: "be terse" }] },
    "gpt-5",
  );
  expect(body.instructions).toBe("be terse");
});

test("lifts tool use and tool result to top-level items", () => {
  const { body } = toResponsesWire(
    {
      ...base,
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "call_1", name: "get_weather", input: { city: "SF" } }],
        },
        {
          role: "user",
          content: [{ type: "toolResult", toolUseId: "call_1", content: "sunny", isError: false }],
        },
      ],
    },
    "gpt-5",
  );
  expect(body.input[0]).toEqual({
    type: "function_call",
    call_id: "call_1",
    name: "get_weather",
    arguments: '{"city":"SF"}',
  });
  expect(body.input[1]).toEqual({
    type: "function_call_output",
    call_id: "call_1",
    output: "sunny",
  });
});

test("flattens tool definitions and maps tool choice", () => {
  const { body } = toResponsesWire(
    {
      ...base,
      tools: [{ name: "f", description: "d", inputSchema: { type: "object" } }],
      toolChoice: { type: "tool", name: "f" },
    },
    "gpt-5",
  );
  expect(body.tools).toEqual([
    { type: "function", name: "f", description: "d", parameters: { type: "object" } },
  ]);
  expect(body.tool_choice).toEqual({ type: "function", name: "f" });
});

test("maps reasoning effort and drops the budget with a degradation", () => {
  const { body, degradations } = toResponsesWire(
    { ...base, reasoning: { effort: "high", budgetTokens: 8000 } },
    "gpt-5",
  );
  expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  expect(degradations).toContain("openai:reasoning-budget-dropped");
});

test("drops images with a degradation when the request carries them", () => {
  const { body, degradations } = toResponsesWire(
    {
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", mediaType: "image/png", data: "AAAA" },
          ],
        },
      ],
    },
    "gpt-5",
  );
  expect(body.input[0]).toEqual({
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    ],
  });
  expect(degradations).toEqual([]);
});

test("maps maxTokens onto max_output_tokens", () => {
  const { body } = toResponsesWire({ ...base, maxTokens: 100 }, "gpt-5");
  expect(body.max_output_tokens).toBe(100);
});

test("decodes a text response stream", async () => {
  const events = await collect(
    decodeResponses(
      msgs(
        {
          event: "response.created",
          data: JSON.stringify({ response: { id: "resp_1", model: "gpt-5" } }),
        },
        {
          event: "response.output_item.added",
          data: JSON.stringify({ output_index: 0, item: { type: "message" } }),
        },
        {
          event: "response.content_part.added",
          data: JSON.stringify({
            output_index: 0,
            content_index: 0,
            part: { type: "output_text" },
          }),
        },
        {
          event: "response.output_text.delta",
          data: JSON.stringify({ output_index: 0, content_index: 0, delta: "Hel" }),
        },
        {
          event: "response.output_text.delta",
          data: JSON.stringify({ output_index: 0, content_index: 0, delta: "lo" }),
        },
        {
          event: "response.content_part.done",
          data: JSON.stringify({ output_index: 0, content_index: 0 }),
        },
        {
          event: "response.completed",
          data: JSON.stringify({
            response: {
              status: "completed",
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                input_tokens_details: { cached_tokens: 4 },
              },
            },
          }),
        },
      ),
    ),
  );

  expect(events[0]).toEqual({ type: "start", id: "resp_1", model: "gpt-5" });
  expect(events[1]).toEqual({ type: "blockStart", index: 0, block: { type: "text" } });
  expect(events[2]).toEqual({ type: "blockDelta", index: 0, delta: { type: "text", text: "Hel" } });
  expect(events.at(-1)).toEqual({
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 0 },
  });
});

test("assigns distinct ir indices to reasoning and message items", async () => {
  const events = await collect(
    decodeResponses(
      msgs(
        {
          event: "response.output_item.added",
          data: JSON.stringify({ output_index: 0, item: { type: "reasoning" } }),
        },
        {
          event: "response.reasoning_summary_text.delta",
          data: JSON.stringify({ output_index: 0, content_index: 0, delta: "thinking" }),
        },
        {
          event: "response.output_item.added",
          data: JSON.stringify({ output_index: 1, item: { type: "message" } }),
        },
        {
          event: "response.content_part.added",
          data: JSON.stringify({
            output_index: 1,
            content_index: 0,
            part: { type: "output_text" },
          }),
        },
        {
          event: "response.output_text.delta",
          data: JSON.stringify({ output_index: 1, content_index: 0, delta: "answer" }),
        },
      ),
    ),
  );
  expect(events[0]).toEqual({ type: "blockStart", index: 0, block: { type: "thinking" } });
  expect(events[1]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "thinking", text: "thinking" },
  });
  expect(events[2]).toEqual({ type: "blockStart", index: 1, block: { type: "text" } });
  expect(events[3]).toEqual({
    type: "blockDelta",
    index: 1,
    delta: { type: "text", text: "answer" },
  });
});

test("decodes function call items with argument deltas", async () => {
  const events = await collect(
    decodeResponses(
      msgs(
        {
          event: "response.output_item.added",
          data: JSON.stringify({
            output_index: 0,
            item: { type: "function_call", call_id: "call_1", name: "f" },
          }),
        },
        {
          event: "response.function_call_arguments.delta",
          data: JSON.stringify({ output_index: 0, delta: '{"a":1}' }),
        },
        { event: "response.output_item.done", data: JSON.stringify({ output_index: 0 }) },
        {
          event: "response.completed",
          data: JSON.stringify({ response: { status: "completed", usage: {} } }),
        },
      ),
    ),
  );
  expect(events[0]).toEqual({
    type: "blockStart",
    index: 0,
    block: { type: "toolUse", id: "call_1", name: "f" },
  });
  expect(events[1]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "toolJson", partial: '{"a":1}' },
  });
  expect(events[2]).toEqual({ type: "blockEnd", index: 0 });
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "toolUse" });
});

test("maps an incomplete response with a token cap onto maxTokens", async () => {
  const events = await collect(
    decodeResponses(
      msgs({
        event: "response.completed",
        data: JSON.stringify({
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: {},
          },
        }),
      }),
    ),
  );
  expect(events[0]).toMatchObject({ type: "end", stopReason: "maxTokens" });
});

test("turns a response.failed event into an error event", async () => {
  const events = await collect(
    decodeResponses(
      msgs({
        event: "response.failed",
        data: JSON.stringify({
          response: { error: { code: "rate_limit_exceeded", message: "slow down" } },
        }),
      }),
    ),
  );
  expect(events[0]).toEqual({
    type: "error",
    code: "RATE_LIMIT",
    message: "slow down",
    retryable: true,
  });
});
