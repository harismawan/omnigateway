import { expect, test } from "bun:test";
import type { ChatRequest, StreamEvent } from "@omni/ir";
import { decodeChat } from "../src/kimi/decode.ts";
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
  const { body, degradations } = toChatWire({ ...base, reasoning: { effort: "high" } }, "kimi-k2");
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
      msgs({
        event: "message",
        data: JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
      }),
    ),
  );
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "maxTokens" });
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

test("the registry exposes exactly the three v1 providers", () => {
  expect(Object.keys(ADAPTERS).sort()).toEqual(["anthropic", "kimi", "openai"]);
  expect(ADAPTERS.kimi.capabilities.images).toBe(false);
  expect(ADAPTERS.anthropic.capabilities.reasoning).toBe(true);
});
