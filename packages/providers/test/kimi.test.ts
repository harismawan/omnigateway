import { expect, test } from "bun:test";
import type { ChatRequest, StreamEvent } from "@omni/ir";
import type { HttpRequest } from "../src/index.ts";
import { decodeChat } from "../src/kimi/decode.ts";
import { kimiAdapter } from "../src/kimi/index.ts";
import { toChatWire } from "../src/kimi/wire.ts";
import { ADAPTERS } from "../src/registry.ts";
import type { SseMessage } from "../src/sse.ts";

const base: ChatRequest = {
  model: "cheap",
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

test("collapses single text blocks to a plain string content", () => {
  const { body } = toChatWire(base, "kimi-k2");
  expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  expect(body.model).toBe("kimi-k2");
  expect(body.stream).toBe(true);
});

test("prepends the system prompt as a system message", () => {
  const { body } = toChatWire({ ...base, system: [{ type: "text", text: "be terse" }] }, "kimi-k2");
  expect(body.messages[0]).toEqual({ role: "system", content: "be terse" });
});

test("emits assistant tool_calls and a tool role result", () => {
  const { body } = toChatWire(
    {
      ...base,
      messages: [
        { role: "assistant", content: [{ type: "toolUse", id: "c1", name: "f", input: { a: 1 } }] },
        {
          role: "user",
          content: [{ type: "toolResult", toolUseId: "c1", content: "ok", isError: false }],
        },
      ],
    },
    "kimi-k2",
  );
  expect(body.messages[0]).toEqual({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
  });
  expect(body.messages[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
});

test("drops images with a degradation", () => {
  const { body, degradations } = toChatWire(
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
    "kimi-k2",
  );
  expect(body.messages[0]).toEqual({ role: "user", content: "look" });
  expect(degradations).toContain("kimi:images-dropped");
});

test("drops reasoning config with a degradation", () => {
  const { body, degradations } = toChatWire(
    { ...base, reasoning: { mode: "adaptive", effort: "high" } },
    "kimi-k2",
  );
  expect(body.reasoning).toBeUndefined();
  expect(degradations).toContain("kimi:reasoning-dropped");
});

test("decodes chat completion chunks into canonical events", async () => {
  const events = await collect(
    decodeChat(
      msgs(
        {
          event: "message",
          data: JSON.stringify({
            id: "c1",
            model: "kimi-k2",
            choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }],
          }),
        },
        {
          event: "message",
          data: JSON.stringify({ choices: [{ index: 0, delta: { content: "lo" } }] }),
        },
        {
          event: "message",
          data: JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        },
        { event: "message", data: "[DONE]" },
      ),
    ),
  );

  expect(events[0]).toEqual({ type: "start", id: "c1", model: "kimi-k2" });
  expect(events[1]).toEqual({ type: "blockStart", index: 0, block: { type: "text" } });
  expect(events[2]).toEqual({ type: "blockDelta", index: 0, delta: { type: "text", text: "Hel" } });
  expect(events.at(-1)).toEqual({
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
});

test("decodes streamed tool calls indexed after text", async () => {
  const events = await collect(
    decodeChat(
      msgs(
        {
          event: "message",
          data: JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: '{"a"' } }],
                },
              },
            ],
          }),
        },
        {
          event: "message",
          data: JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }],
          }),
        },
        {
          event: "message",
          data: JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        },
        { event: "message", data: "[DONE]" },
      ),
    ),
  );
  expect(events[0]).toEqual({
    type: "blockStart",
    index: 0,
    block: { type: "toolUse", id: "c1", name: "f" },
  });
  expect(events[1]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "toolJson", partial: '{"a"' },
  });
  expect(events[2]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "toolJson", partial: ":1}" },
  });
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "toolUse" });
});

test("maps a length finish reason", async () => {
  const events = await collect(
    decodeChat(
      msgs(
        {
          event: "message",
          data: JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
        },
        { event: "message", data: "[DONE]" },
      ),
    ),
  );
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "maxTokens" });
});

test("emits UPSTREAM when EOF follows finish_reason without [DONE]", async () => {
  const events = await collect(
    decodeChat(
      msgs(
        {
          event: "message",
          data: JSON.stringify({ choices: [{ delta: { content: "partial" } }] }),
        },
        {
          event: "message",
          data: JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        },
      ),
    ),
  );

  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(events.some((event) => event.type === "end")).toBe(false);
});

test("emits UPSTREAM when EOF arrives without [DONE]", async () => {
  const events = await collect(
    decodeChat(
      msgs({
        event: "message",
        data: JSON.stringify({ choices: [{ delta: { content: "partial" } }] }),
      }),
    ),
  );

  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(events.some((event) => event.type === "end")).toBe(false);
});

test("[DONE] with no finish_reason still terminates the stream", async () => {
  const events = await collect(
    decodeChat(
      msgs(
        { event: "message", data: JSON.stringify({ choices: [{ delta: { content: "x" } }] }) },
        { event: "message", data: "[DONE]" },
      ),
    ),
  );
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "endTurn" });
});

test("OAuth inference uses the Kimi Coding API", async () => {
  let sent: HttpRequest | null = null;
  await kimiAdapter.send({
    request: base,
    model: "kimi-for-coding",
    credentials: {
      accessToken: "test-token",
      apiKey: null,
      providerData: { deviceId: "device-1" },
    },
    http: async (request) => {
      sent = request;
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({ start: (controller) => controller.close() }),
        text: async () => "",
      };
    },
    signal: new AbortController().signal,
  });

  if (sent === null) throw new Error("adapter did not send a request");
  expect((sent as HttpRequest).url).toBe("https://api.kimi.com/coding/v1/chat/completions");
});

test("the registry exposes exactly the three v1 providers", () => {
  expect(Object.keys(ADAPTERS).sort()).toEqual(["anthropic", "kimi", "openai"]);
  expect(ADAPTERS.kimi.capabilities.images).toBe(false);
  expect(ADAPTERS.anthropic.capabilities.reasoning).toBe(true);
});

test("passes a mid-conversation system turn through in position", () => {
  const { body } = toChatWire(
    {
      model: "m",
      system: [{ type: "text", text: "top-level prompt" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "system", content: [{ type: "text", text: "Write Go." }] },
      ],
      stream: false,
    },
    "k3-256k",
  );

  // The request-level prompt is hoisted to the leading system message, and the
  // mid-conversation turn keeps its own place after the user turn.
  expect(body.messages).toEqual([
    { role: "system", content: "top-level prompt" },
    { role: "user", content: "hi" },
    { role: "system", content: "Write Go." },
  ]);
});

test("subtracts kimi's cache hits out of the prompt total", async () => {
  const events = await collect(
    decodeChat(
      msgs(
        {
          event: "message",
          data: JSON.stringify({ id: "c1", model: "kimi-k2", choices: [] }),
        },
        {
          event: "message",
          data: JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            // Kimi reports the whole prompt in `prompt_tokens`, with the hits
            // as a subset. The IR wants the miss remainder.
            usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60 },
          }),
        },
        { event: "message", data: "[DONE]" },
      ),
    ),
  );

  expect(events.at(-1)).toEqual({
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 40, outputTokens: 5, cacheReadTokens: 60, cacheWriteTokens: 0 },
  });
});

test("asks for usage on the stream, which is the only way kimi reports any", () => {
  const { body } = toChatWire(base, "kimi-k2");
  // The adapter always streams upstream, and an OpenAI-compatible chat stream
  // carries no usage object at all unless this is set — no tokens, no cost,
  // no cache counters.
  expect(body.stream_options).toEqual({ include_usage: true });
});

test("reads kimi's cache hits from the openai-compatible field", async () => {
  const events = await collect(
    decodeChat(
      msgs(
        { event: "message", data: JSON.stringify({ id: "c1", model: "kimi-k2", choices: [] }) },
        {
          event: "message",
          data: JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 5,
              prompt_tokens_details: { cached_tokens: 60 },
            },
          }),
        },
        { event: "message", data: "[DONE]" },
      ),
    ),
  );

  expect(events.at(-1)).toEqual({
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 40, outputTokens: 5, cacheReadTokens: 60, cacheWriteTokens: 0 },
  });
});

test("reads cache creation tokens when the upstream reports them", async () => {
  const events = await collect(
    decodeChat(
      msgs(
        { event: "message", data: JSON.stringify({ id: "c1", model: "kimi-k2", choices: [] }) },
        {
          event: "message",
          data: JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 5,
              prompt_tokens_details: { cached_tokens: 60, cache_creation_tokens: 10 },
            },
          }),
        },
        { event: "message", data: "[DONE]" },
      ),
    ),
  );

  expect(events.at(-1)).toMatchObject({
    usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 60, cacheWriteTokens: 10 },
  });
});

test("records that a 1m request could not be honoured here", () => {
  const { degradations } = toChatWire({ ...base, betas: ["context-1m-2025-08-07"] }, "k2");
  expect(degradations).toContain("kimi:context-1m-dropped");
});

test("records nothing when no 1m request was made", () => {
  const { degradations } = toChatWire(base, "k2");
  expect(degradations).not.toContain("kimi:context-1m-dropped");
});
