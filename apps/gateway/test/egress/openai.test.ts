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
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4000, cacheWriteTokens: 120 },
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
  // OpenAI counts cached tokens inside `prompt_tokens`, unlike the IR — so the
  // prompt total is rebuilt here and the cached part reported as the subset it
  // is. A client subtracting one from the other must get the uncached input.
  expect(last.usage).toEqual({
    prompt_tokens: 4130,
    completion_tokens: 2,
    total_tokens: 4132,
    prompt_tokens_details: { cached_tokens: 4000 },
  });
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

test("streams upstream reasoning as reasoning_content chunks ahead of content", async () => {
  const f = await frames(
    openaiStream(
      src(
        { type: "start", id: "msg_1", model: "deepseek-r1" },
        { type: "blockStart", index: 0, block: { type: "thinking" } },
        { type: "blockDelta", index: 0, delta: { type: "thinking", text: "why " } },
        { type: "blockDelta", index: 0, delta: { type: "thinking", text: "so" } },
        { type: "blockEnd", index: 0 },
        { type: "blockStart", index: 1, block: { type: "text" } },
        { type: "blockDelta", index: 1, delta: { type: "text", text: "answer" } },
        { type: "blockEnd", index: 1 },
        {
          type: "end",
          stopReason: "endTurn",
          usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      ),
      "chatcmpl-2",
      1000,
    ),
  );

  // Role leads, then one chunk per reasoning delta under the DeepSeek/
  // OpenRouter spelling, then the content — [DONE] still terminates.
  const deltas = f
    .filter((x) => x.data !== "[DONE]")
    .map((x) => JSON.parse(x.data).choices[0].delta);
  expect(deltas).toEqual([
    { role: "assistant" },
    { reasoning_content: "why " },
    { reasoning_content: "so" },
    { content: "answer" },
    {},
  ]);
});

test("non-streaming responses carry reasoning_content beside the answer", () => {
  const body = openaiResponse(
    {
      id: "resp_1",
      model: "deepseek-r1",
      stopReason: "endTurn",
      usage: { inputTokens: 4, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      content: [
        { type: "thinking", text: "because" },
        { type: "text", text: "answer" },
      ],
    },
    "chatcmpl-3",
    1000,
  ) as NonStreamingBody;

  expect(body.choices[0]?.message).toEqual({
    role: "assistant",
    content: "answer",
    reasoning_content: "because",
  });
});

test("reasoning rides beside null content when only tools answer", () => {
  const body = openaiResponse(
    {
      id: "resp_2",
      model: "deepseek-r1",
      stopReason: "toolUse",
      usage: { inputTokens: 4, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      content: [
        { type: "thinking", text: "plan" },
        { type: "toolUse", id: "c1", name: "f", input: { a: 1 } },
      ],
    },
    "chatcmpl-4",
    1000,
  ) as NonStreamingBody;

  expect(body.choices[0]?.message).toEqual({
    role: "assistant",
    content: null,
    reasoning_content: "plan",
    tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
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

test("renders an error event without a successful [DONE] marker", async () => {
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
  expect(f.some((frame) => frame.data === "[DONE]")).toBe(false);
});

type NonStreamingBody = {
  object: string;
  usage: { total_tokens: number };
  choices: {
    message: {
      role: string;
      content: string | null;
      reasoning_content?: string;
      tool_calls?: unknown[];
    };
    finish_reason: string;
  }[];
};

test("builds a non-streaming chat completion body", () => {
  const body = openaiResponse(collect(TEXT), "chatcmpl-1", 1000) as NonStreamingBody;
  expect(body.object).toBe("chat.completion");
  expect(body.choices[0]?.message).toEqual({ role: "assistant", content: "Hi" });
  expect(body.choices[0]?.finish_reason).toBe("stop");
  expect(body.usage.total_tokens).toBe(4132);
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

test("reports cached prompt tokens on a non-streaming body", () => {
  const body = openaiResponse(collect(TEXT), "chatcmpl-1", 1000) as {
    usage: Record<string, unknown>;
  };
  expect(body.usage).toEqual({
    prompt_tokens: 4130,
    completion_tokens: 2,
    total_tokens: 4132,
    prompt_tokens_details: { cached_tokens: 4000 },
  });
});
