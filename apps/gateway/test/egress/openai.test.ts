import { expect, test } from "bun:test";
import { collect, type StreamEvent } from "@omni/ir";
import { openaiResponse, openaiStream } from "../../src/egress/openai.ts";

async function* src(...events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

const TEXT: StreamEvent[] = [
  { type: "start", id: "msg_1", model: "gpt-5" },
  { type: "blockStart", index: 0, block: { type: "text" } },
  { type: "blockDelta", index: 0, delta: { type: "text", text: "Hi" } },
  { type: "blockEnd", index: 0 },
  {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

async function frames(g: AsyncGenerator<{ event: string; data: string }>) {
  const out: { data: string }[] = [];
  for await (const f of g) out.push({ data: f.data });
  return out;
}

test("emits chat completion chunks terminated by [DONE]", async () => {
  const f = await frames(openaiStream(src(...TEXT), "chatcmpl-1", 1000));
  expect(f.at(-1)?.data).toBe("[DONE]");

  const first = JSON.parse(f[0]?.data as string);
  expect(first.object).toBe("chat.completion.chunk");
  expect(first.id).toBe("chatcmpl-1");
  expect(first.created).toBe(1000);
  expect(first.choices[0].delta).toEqual({ role: "assistant", content: "" });

  const content = JSON.parse(f[1]?.data as string);
  expect(content.choices[0].delta).toEqual({ content: "Hi" });

  const last = JSON.parse(f[f.length - 2]?.data as string);
  expect(last.choices[0].finish_reason).toBe("stop");
  expect(last.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
});

test("streams tool calls with index and argument deltas", async () => {
  const f = await frames(
    openaiStream(
      src(
        { type: "blockStart", index: 0, block: { type: "toolUse", id: "c1", name: "f" } },
        { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"a"' } },
      ),
      "chatcmpl-1",
      1000,
    ),
  );
  const start = JSON.parse(f[0]?.data as string);
  expect(start.choices[0].delta.tool_calls[0]).toEqual({
    index: 0,
    id: "c1",
    type: "function",
    function: { name: "f", arguments: "" },
  });
  const delta = JSON.parse(f[1]?.data as string);
  expect(delta.choices[0].delta.tool_calls[0]).toEqual({
    index: 0,
    function: { arguments: '{"a"' },
  });
});

test("sends role: assistant on the first frame of a tool-only response", async () => {
  const f = await frames(
    openaiStream(
      src(
        { type: "start", id: "msg_1", model: "gpt-5" },
        { type: "blockStart", index: 0, block: { type: "toolUse", id: "c1", name: "f" } },
        { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"a"' } },
        { type: "blockEnd", index: 0 },
        {
          type: "end",
          stopReason: "toolUse",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      ),
      "chatcmpl-1",
      1000,
    ),
  );
  const nonDone = f.filter((x) => x.data !== "[DONE]").map((x) => JSON.parse(x.data));
  expect(nonDone[0]?.choices[0].delta.role).toBe("assistant");
  for (const chunk of nonDone.slice(1)) {
    expect(chunk.choices[0].delta.role).toBeUndefined();
  }
});

test("maps a tool-use stop reason onto tool_calls", async () => {
  const f = await frames(
    openaiStream(
      src({
        type: "end",
        stopReason: "toolUse",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
      "chatcmpl-1",
      1000,
    ),
  );
  expect(JSON.parse(f[0]?.data as string).choices[0].finish_reason).toBe("tool_calls");
});

test("thinking content is not emitted on the chat completions surface", async () => {
  const f = await frames(
    openaiStream(
      src(
        { type: "blockStart", index: 0, block: { type: "thinking" } },
        { type: "blockDelta", index: 0, delta: { type: "thinking", text: "hm" } },
      ),
      "chatcmpl-1",
      1000,
    ),
  );
  expect(f.filter((x) => x.data !== "[DONE]")).toHaveLength(0);
});

test("renders an error event as an openai error frame", async () => {
  const f = await frames(
    openaiStream(
      src({ type: "error", code: "RATE_LIMIT", message: "slow", retryable: true }),
      "chatcmpl-1",
      1000,
    ),
  );
  const body = JSON.parse(f[0]?.data as string);
  expect(body.error).toEqual({
    message: "slow",
    type: "rate_limit_error",
    code: "rate_limit_exceeded",
  });
});

type NonStreamingBody = {
  object: string;
  usage: { total_tokens: number };
  choices: {
    message: { role: string; content: string | null; tool_calls?: unknown[] };
    finish_reason: string;
  }[];
};

test("builds a non-streaming chat completion body", () => {
  const body = openaiResponse(collect(TEXT), "chatcmpl-1", 1000) as NonStreamingBody;
  expect(body.object).toBe("chat.completion");
  expect(body.choices[0]?.message).toEqual({ role: "assistant", content: "Hi" });
  expect(body.choices[0]?.finish_reason).toBe("stop");
  expect(body.usage.total_tokens).toBe(12);
});

test("renders collected tool calls in a non-streaming body", () => {
  const body = openaiResponse(
    collect([
      { type: "blockStart", index: 0, block: { type: "toolUse", id: "c1", name: "f" } },
      { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"a":1}' } },
      { type: "blockEnd", index: 0 },
      {
        type: "end",
        stopReason: "toolUse",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]),
    "chatcmpl-1",
    1000,
  ) as NonStreamingBody;
  expect(body.choices[0]?.message.content).toBeNull();
  expect(body.choices[0]?.message.tool_calls?.[0]).toEqual({
    id: "c1",
    type: "function",
    function: { name: "f", arguments: '{"a":1}' },
  });
});
