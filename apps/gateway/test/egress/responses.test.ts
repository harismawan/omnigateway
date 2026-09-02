import { expect, test } from "bun:test";
import type { StreamEvent } from "@omni/ir";
import { openaiRateLimitHeaders } from "../../src/egress/openai.ts";
import {
  responsesErrorBody,
  responsesRateLimitHeaders,
  responsesResponse,
  responsesStream,
} from "../../src/egress/responses.ts";

async function* src(...events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

const RENDER = { requestId: "req_1", created: 1000, customToolNames: new Set<string>() };

async function frames(g: AsyncGenerator<{ event: string; data: string }>) {
  const out: { event: string; data: string }[] = [];
  for await (const f of g) out.push(f);
  return out;
}

/**
 * The frames before the terminal pair.
 *
 * A fixture that stops without an `end` event gets a synthesized
 * `response.failed` and `[DONE]` — that is the behaviour a separate test owns.
 * The assembly tests below are about what an item emits, so they read the
 * stream up to that point rather than restating the terminal in every case.
 */
async function stage(g: AsyncGenerator<{ event: string; data: string }>) {
  return (await frames(g)).slice(0, -2);
}

test("opens with response.created then response.in_progress, numbered from one", async () => {
  const f = await stage(
    responsesStream(src({ type: "start", id: "msg_1", model: "gpt-5" }), RENDER),
  );

  expect(f.map((x) => x.event)).toEqual(["response.created", "response.in_progress"]);
  const created = JSON.parse(f[0]?.data as string);
  expect(created.type).toBe("response.created");
  expect(created.sequence_number).toBe(1);
  expect(created.response.id).toBe("resp_req_1");
  expect(created.response.object).toBe("response");
  expect(created.response.created_at).toBe(1000);
  expect(created.response.model).toBe("gpt-5");
  expect(created.response.status).toBe("in_progress");
  expect(JSON.parse(f[1]?.data as string).sequence_number).toBe(2);
});

test("assembles a text block into one message item with a single content part", async () => {
  const f = await stage(
    responsesStream(
      src(
        { type: "blockStart", index: 0, block: { type: "text" } },
        { type: "blockDelta", index: 0, delta: { type: "text", text: "Hi" } },
        { type: "blockDelta", index: 0, delta: { type: "text", text: " there" } },
        { type: "blockEnd", index: 0 },
      ),
      RENDER,
    ),
  );

  expect(f.map((x) => x.event)).toEqual([
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
  ]);

  const bodies = f.map((x) => JSON.parse(x.data));
  expect(bodies.map((b) => b.sequence_number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  // Every event of an item names the same output_index, and content_index is
  // the constant 0 — one part per message item, by construction.
  for (const b of bodies) expect(b.output_index).toBe(0);
  for (const b of bodies.slice(1, 6)) expect(b.content_index).toBe(0);

  const added = bodies[0];
  expect(added.item).toEqual({
    id: "msg_req_1_0",
    type: "message",
    status: "in_progress",
    role: "assistant",
    content: [],
  });
  expect(bodies[1].part).toEqual({ type: "output_text", text: "", annotations: [] });
  expect(bodies[2].delta).toBe("Hi");
  expect(bodies[4].text).toBe("Hi there");
  expect(bodies[5].part).toEqual({ type: "output_text", text: "Hi there", annotations: [] });
  expect(bodies[6].item).toEqual({
    id: "msg_req_1_0",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "Hi there", annotations: [] }],
  });
  // Every event carries the id of the item it belongs to.
  for (const b of bodies.slice(1, 6)) expect(b.item_id).toBe("msg_req_1_0");
});

test("assembles a thinking block into a reasoning item with a summary part", async () => {
  const f = await stage(
    responsesStream(
      src(
        { type: "blockStart", index: 0, block: { type: "thinking" } },
        { type: "blockDelta", index: 0, delta: { type: "thinking", text: "weighing" } },
        { type: "blockEnd", index: 0 },
      ),
      RENDER,
    ),
  );

  expect(f.map((x) => x.event)).toEqual([
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
  ]);
  const bodies = f.map((x) => JSON.parse(x.data));
  expect(bodies[0].item.type).toBe("reasoning");
  expect(bodies[5].item.summary).toEqual([{ type: "summary_text", text: "weighing" }]);
});

test("a thinking signature delta reaches no client", async () => {
  // Anthropic's own field. There is no Responses spelling for it, and inventing
  // one would put an opaque blob in a stream a client parses strictly.
  const f = await stage(
    responsesStream(
      src(
        { type: "blockStart", index: 0, block: { type: "thinking" } },
        { type: "blockDelta", index: 0, delta: { type: "thinkingSignature", signature: "sig" } },
        { type: "blockEnd", index: 0 },
      ),
      RENDER,
    ),
  );
  expect(f.map((x) => x.event)).not.toContain("response.reasoning_summary_text.delta");
  expect(f.some((x) => x.data.includes("sig"))).toBe(false);
});

test("a declared function tool streams its arguments as they arrive", async () => {
  const f = await stage(
    responsesStream(
      src(
        { type: "blockStart", index: 0, block: { type: "toolUse", id: "call_1", name: "shell" } },
        { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"cmd"' } },
        { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: ':"ls"}' } },
        { type: "blockEnd", index: 0 },
      ),
      RENDER,
    ),
  );

  expect(f.map((x) => x.event)).toEqual([
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.output_item.done",
  ]);
  const bodies = f.map((x) => JSON.parse(x.data));
  expect(bodies[0].item).toEqual({
    id: "fc_call_1",
    type: "function_call",
    status: "in_progress",
    call_id: "call_1",
    name: "shell",
    arguments: "",
  });
  expect(bodies[3].arguments).toBe('{"cmd":"ls"}');
  expect(bodies[4].item.status).toBe("completed");
});

test("a freeform tool emits its program whole at close, never as JSON fragments", async () => {
  // Streaming the raw fragments would show the client the `{"input": ...}`
  // envelope instead of the program the tool is written to receive.
  const f = await stage(
    responsesStream(
      src(
        {
          type: "blockStart",
          index: 0,
          block: { type: "toolUse", id: "c1", name: "apply_patch" },
        },
        { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"input":"*** Beg' } },
        { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: 'in Patch"}' } },
        { type: "blockEnd", index: 0 },
      ),
      { ...RENDER, customToolNames: new Set(["apply_patch"]) },
    ),
  );

  expect(f.map((x) => x.event)).toEqual([
    "response.output_item.added",
    "response.custom_tool_call_input.delta",
    "response.custom_tool_call_input.done",
    "response.output_item.done",
  ]);
  const bodies = f.map((x) => JSON.parse(x.data));
  expect(bodies[0].item.type).toBe("custom_tool_call");
  expect(bodies[1].delta).toBe("*** Begin Patch");
  expect(bodies[2].input).toBe("*** Begin Patch");
  expect(bodies[3].item.input).toBe("*** Begin Patch");
});

test("an openai-owned native block is replayed as its own item", async () => {
  const data = { id: "rs_1", summary: [], encrypted_content: "gAAAAA" };
  const f = await stage(
    responsesStream(
      src(
        {
          type: "blockStart",
          index: 0,
          block: { type: "providerNative", provider: "openai", blockType: "reasoning", data },
        },
        { type: "blockEnd", index: 0 },
      ),
      RENDER,
    ),
  );

  expect(f.map((x) => x.event)).toEqual([
    "response.output_item.added",
    "response.output_item.done",
  ]);
  const bodies = f.map((x) => JSON.parse(x.data));
  expect(bodies[0].item).toEqual({ type: "reasoning", ...data });
});

test("two items in one stream never share an output_index", async () => {
  // The preamble-then-tool-call shape that collided in a peer gateway: a short
  // message, then a tool call. A client keying per-item state by output_index
  // silently drops the second when they collide.
  const f = await stage(
    responsesStream(
      src(
        { type: "blockStart", index: 0, block: { type: "text" } },
        { type: "blockDelta", index: 0, delta: { type: "text", text: "one moment" } },
        { type: "blockEnd", index: 0 },
        { type: "blockStart", index: 1, block: { type: "toolUse", id: "call_1", name: "shell" } },
        { type: "blockDelta", index: 1, delta: { type: "toolJson", partial: "{}" } },
        { type: "blockEnd", index: 1 },
      ),
      RENDER,
    ),
  );

  const bodies = f.map((x) => JSON.parse(x.data));
  const message = bodies.filter((b) => b.type === "response.output_item.done")[0];
  const call = bodies.filter((b) => b.type === "response.output_item.done")[1];
  expect(message.output_index).toBe(0);
  expect(call.output_index).toBe(1);
  // Six events close the message, four the tool call, and the counter runs
  // across both rather than restarting per item.
  expect(bodies.map((b) => b.sequence_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

const USAGE = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 900,
  cacheWriteTokens: 30,
};

test("closes with response.completed carrying usage, then the [DONE] sentinel", async () => {
  const f = await frames(
    responsesStream(src({ type: "end", stopReason: "endTurn", usage: USAGE }), RENDER),
  );

  expect(f.map((x) => x.event)).toEqual(["response.completed", "message"]);
  expect(f[1]?.data).toBe("[DONE]");

  const body = JSON.parse(f[0]?.data as string);
  expect(body.response.status).toBe("completed");
  expect(body.response.incomplete_details).toBeUndefined();
  // input_tokens is the WHOLE prompt. IR's inputTokens is the uncached
  // remainder, so reporting it raw under-reports every cached request — here it
  // would say 100 against a real prompt of 1030.
  expect(body.response.usage).toEqual({
    input_tokens: 1030,
    input_tokens_details: { cached_tokens: 900 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 1050,
  });
});

test("a truncated turn is incomplete and says which limit stopped it", async () => {
  const f = await frames(
    responsesStream(src({ type: "end", stopReason: "maxTokens", usage: USAGE }), RENDER),
  );
  const body = JSON.parse(f[0]?.data as string);
  expect(f[0]?.event).toBe("response.incomplete");
  expect(body.response.status).toBe("incomplete");
  expect(body.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
});

test("a filtered turn is incomplete for that reason", async () => {
  const f = await frames(
    responsesStream(src({ type: "end", stopReason: "contentFilter", usage: USAGE }), RENDER),
  );
  expect(JSON.parse(f[0]?.data as string).response.incomplete_details).toEqual({
    reason: "content_filter",
  });
});

test("a paused turn reads as completed, with no invented reason", async () => {
  // Anthropic's own stop reason, and this dialect has no pause. The chat
  // surface already reads it as a normal finish; an invented
  // incomplete_details.reason would land where clients switch.
  const f = await frames(
    responsesStream(src({ type: "end", stopReason: "pauseTurn", usage: USAGE }), RENDER),
  );
  const body = JSON.parse(f[0]?.data as string);
  expect(f[0]?.event).toBe("response.completed");
  expect(body.response.status).toBe("completed");
  expect(body.response.incomplete_details).toBeUndefined();
});

test("a tool-use finish is a completed response", async () => {
  const f = await frames(
    responsesStream(src({ type: "end", stopReason: "toolUse", usage: USAGE }), RENDER),
  );
  expect(JSON.parse(f[0]?.data as string).response.status).toBe("completed");
});

test("an error event closes the stream as response.failed", async () => {
  const f = await frames(
    responsesStream(
      src({ type: "error", code: "UPSTREAM", message: "upstream said no", retryable: false }),
      RENDER,
    ),
  );

  expect(f.map((x) => x.event)).toEqual(["response.failed", "message"]);
  const body = JSON.parse(f[0]?.data as string);
  expect(body.response.status).toBe("failed");
  expect(body.response.error).toEqual({
    code: "server_error",
    message: "upstream said no",
  });
});

test("an open item is closed before the terminal event, not left dangling", async () => {
  const f = await frames(
    responsesStream(
      src(
        { type: "blockStart", index: 0, block: { type: "text" } },
        { type: "blockDelta", index: 0, delta: { type: "text", text: "hi" } },
        { type: "end", stopReason: "endTurn", usage: USAGE },
      ),
      RENDER,
    ),
  );
  expect(f.map((x) => x.event)).toEqual([
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
    "message",
  ]);
});

test("a stream that stops without a terminal event still terminates the client", async () => {
  // Codex waits on a terminal event and closes on it. Without one it hangs
  // until its own timeout, which reads to the operator as a slow model rather
  // than a dropped upstream.
  const f = await frames(
    responsesStream(src({ type: "blockStart", index: 0, block: { type: "text" } }), RENDER),
  );

  expect(f.map((x) => x.event)).toEqual([
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.failed",
    "message",
  ]);
  const body = JSON.parse(f[5]?.data as string);
  expect(body.response.error).toEqual({
    code: "stream_disconnected",
    message: "stream closed before response.completed",
  });
});

test("the completed response carries the items the stream produced", async () => {
  const f = await frames(
    responsesStream(
      src(
        { type: "start", id: "m", model: "gpt-5" },
        { type: "blockStart", index: 0, block: { type: "text" } },
        { type: "blockDelta", index: 0, delta: { type: "text", text: "done" } },
        { type: "blockEnd", index: 0 },
        { type: "end", stopReason: "endTurn", usage: USAGE },
      ),
      RENDER,
    ),
  );
  const completed = JSON.parse(f[f.length - 2]?.data as string);
  expect(completed.response.output).toEqual([
    {
      id: "msg_req_1_0",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "done", annotations: [] }],
    },
  ]);
});

test("the buffered response renders the same items and usage as the stream", async () => {
  const collected = {
    id: "msg_1",
    model: "gpt-5",
    content: [
      { type: "text" as const, text: "done" },
      { type: "toolUse" as const, id: "call_1", name: "shell", input: { cmd: "ls" } },
    ],
    stopReason: "toolUse" as const,
    usage: USAGE,
  };

  const body = responsesResponse(collected, RENDER) as Record<string, unknown>;
  expect(body).toMatchObject({
    id: "resp_req_1",
    object: "response",
    created_at: 1000,
    status: "completed",
    model: "gpt-5",
    store: false,
  });
  expect(body.output).toEqual([
    {
      id: "msg_req_1_0",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "done", annotations: [] }],
    },
    {
      id: "fc_call_1",
      type: "function_call",
      status: "completed",
      call_id: "call_1",
      name: "shell",
      arguments: '{"cmd":"ls"}',
    },
  ]);
  expect(body.usage).toEqual({
    input_tokens: 1030,
    input_tokens_details: { cached_tokens: 900 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 1050,
  });
});

test("a buffered truncated turn says so the same way the stream does", () => {
  const body = responsesResponse(
    { id: "m", model: "gpt-5", content: [], stopReason: "maxTokens", usage: USAGE },
    RENDER,
  ) as Record<string, unknown>;
  expect(body.status).toBe("incomplete");
  expect(body.incomplete_details).toEqual({ reason: "max_output_tokens" });
});

test("a buffered freeform tool call carries its program, not the envelope", () => {
  const body = responsesResponse(
    {
      id: "m",
      model: "gpt-5",
      content: [
        { type: "toolUse", id: "c1", name: "apply_patch", input: { input: "*** Begin Patch" } },
      ],
      stopReason: "toolUse",
      usage: USAGE,
    },
    { ...RENDER, customToolNames: new Set(["apply_patch"]) },
  ) as Record<string, unknown>;
  expect(body.output).toEqual([
    {
      id: "ctc_c1",
      type: "custom_tool_call",
      status: "completed",
      call_id: "c1",
      name: "apply_patch",
      input: "*** Begin Patch",
    },
  ]);
});

test("an error body names the failure in this dialect", () => {
  expect(responsesErrorBody("RATE_LIMIT", "slow down")).toEqual({
    error: {
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      message: "slow down",
      param: null,
    },
  });
});

test("rate limit headers read the same as the chat surface's", () => {
  const headroom = {
    requests: { window: "1m" as const, limit: 10, used: 6, remaining: 4, resetAt: 1_000_000 },
  };
  expect(responsesRateLimitHeaders(headroom, 999_000)).toEqual(
    openaiRateLimitHeaders(headroom, 999_000),
  );
});
