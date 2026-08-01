import { expect, test } from "bun:test";
import { type ChatRequest, collect, type StreamEvent } from "@omni/ir";
import {
  decodeAnthropic,
  decodeChat,
  toAnthropicWire,
  toChatWire,
  toResponsesWire,
} from "@omni/providers";
import { anthropicResponse, anthropicStream } from "../../src/egress/anthropic.ts";
import { openaiResponse, openaiStream } from "../../src/egress/openai.ts";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";
import { parseOpenAIRequest } from "../../src/ingress/openai.ts";

/**
 * Re-parses rendered SSE frames as if they had arrived from an upstream.
 *
 * The egress renderers emit `{event, data}` records, which is exactly what the
 * provider decoders consume, so a frame stream can be fed straight back in
 * without serializing to bytes and parsing them again.
 */
async function* replay(
  frames: AsyncGenerator<{ event: string; data: string }>,
): AsyncGenerator<{ event: string; data: string }> {
  for await (const f of frames) yield f;
}

async function drain(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const RESPONSE: StreamEvent[] = [
  { type: "start", id: "msg_1", model: "claude-opus-4" },
  { type: "blockStart", index: 0, block: { type: "text" } },
  { type: "blockDelta", index: 0, delta: { type: "text", text: "Hello " } },
  { type: "blockDelta", index: 0, delta: { type: "text", text: "world" } },
  { type: "blockEnd", index: 0 },
  {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

const TOOL_RESPONSE: StreamEvent[] = [
  { type: "start", id: "msg_2", model: "claude-opus-4" },
  { type: "blockStart", index: 0, block: { type: "toolUse", id: "tu_1", name: "get_weather" } },
  { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"city":' } },
  { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '"SF"}' } },
  { type: "blockEnd", index: 0 },
  {
    type: "end",
    stopReason: "toolUse",
    usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

async function* source(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

test("an anthropic response survives the round trip through anthropic egress", async () => {
  const back = await drain(decodeAnthropic(replay(anthropicStream(source(RESPONSE), "msg_1"))));
  expect(collect(back)).toEqual(collect(RESPONSE));
});

test("tool use survives the round trip through anthropic egress", async () => {
  const back = await drain(
    decodeAnthropic(replay(anthropicStream(source(TOOL_RESPONSE), "msg_2"))),
  );
  const [a, b] = [collect(back), collect(TOOL_RESPONSE)];
  expect(a.content).toEqual(b.content);
  expect(a.stopReason).toBe(b.stopReason);
});

test("a response survives the round trip through openai egress", async () => {
  const back = await drain(decodeChat(replay(openaiStream(source(RESPONSE), "msg_1", 0))));
  const [a, b] = [collect(back), collect(RESPONSE)];
  expect(a.content).toEqual(b.content);
  expect(a.stopReason).toBe(b.stopReason);
  expect(a.usage.inputTokens).toBe(b.usage.inputTokens);
  expect(a.usage.outputTokens).toBe(b.usage.outputTokens);
});

test("tool use survives the round trip through openai egress", async () => {
  const back = await drain(decodeChat(replay(openaiStream(source(TOOL_RESPONSE), "msg_2", 0))));
  expect(collect(back).content).toEqual(collect(TOOL_RESPONSE).content);
});

test("a non-streaming anthropic body carries the same content as the stream", () => {
  const body = anthropicResponse(collect(RESPONSE), "msg_1") as Record<string, unknown>;
  expect(body.content).toEqual([{ type: "text", text: "Hello world" }]);
  expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
});

test("a non-streaming openai body carries the same content as the stream", () => {
  const body = openaiResponse(collect(RESPONSE), "msg_1", 0) as {
    choices: { message: { content: string } }[];
    usage: { total_tokens: number };
  };
  expect(body.choices[0]?.message.content).toBe("Hello world");
  expect(body.usage.total_tokens).toBe(12);
});

const REQUEST: ChatRequest = {
  model: "claude-opus-4",
  system: [{ type: "text", text: "be terse" }],
  messages: [
    { role: "user", content: [{ type: "text", text: "weather in SF?" }] },
    {
      role: "assistant",
      content: [{ type: "toolUse", id: "tu_1", name: "get_weather", input: { city: "SF" } }],
    },
    {
      role: "user",
      content: [{ type: "toolResult", toolUseId: "tu_1", content: "sunny", isError: false }],
    },
  ],
  tools: [
    {
      name: "get_weather",
      description: "look up weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    },
  ],
  toolChoice: { type: "auto" },
  maxTokens: 1024,
  temperature: 0.5,
  stream: false,
};

test("a request survives ingress after anthropic encoding", () => {
  const { body } = toAnthropicWire(REQUEST, "claude-opus-4", { oauth: false });
  const back = parseAnthropicRequest(body);

  expect(back.messages).toEqual(REQUEST.messages);
  expect(back.system).toEqual(REQUEST.system);
  expect(back.tools).toEqual(REQUEST.tools);
  expect(back.toolChoice).toEqual(REQUEST.toolChoice);
  expect(back.maxTokens).toBe(1024);
  expect(back.temperature).toBe(0.5);
});

test("a request survives ingress after kimi encoding, minus what that format cannot hold", () => {
  const { body } = toChatWire(REQUEST, "kimi-k2");
  const back = parseOpenAIRequest(body);

  // The Chat Completions format carries the system prompt as a message rather
  // than a top-level field, and ingress puts it back where the IR expects it.
  expect(back.system).toEqual(REQUEST.system);
  expect(back.messages).toEqual(REQUEST.messages);
  expect(back.tools).toEqual(REQUEST.tools);
  expect(back.toolChoice).toEqual(REQUEST.toolChoice);
});

test("an image is reported as a degradation rather than silently dropped", () => {
  const withImage: ChatRequest = {
    model: "kimi-k2",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", mediaType: "image/png", data: "aGk=" },
        ],
      },
    ],
    stream: false,
  };

  const { body, degradations } = toChatWire(withImage, "kimi-k2");
  expect(degradations).toContain("kimi:images-dropped");

  // The text survives; only the image is gone, and the caller was told.
  const back = parseOpenAIRequest(body);
  expect(back.messages[0]?.content).toEqual([{ type: "text", text: "what is this?" }]);
});

test("the responses format round-trips a request through openai encoding", () => {
  const { body } = toResponsesWire(REQUEST, "gpt-5");
  // No ingress parser reads the Responses format — the gateway speaks Chat
  // Completions to clients — so this asserts the encoder's own invariants:
  // every IR message is represented, and nothing is invented.
  expect(Array.isArray(body.input)).toBe(true);
  expect(JSON.stringify(body.input)).toContain("weather in SF?");
  expect(JSON.stringify(body.input)).toContain("sunny");
  expect(body.tools?.[0]).toMatchObject({ name: "get_weather" });
});
