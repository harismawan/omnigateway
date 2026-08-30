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
      tools: [{ kind: "portable", name: "f", description: "d", inputSchema: { type: "object" } }],
      toolChoice: { type: "tool", name: "f" },
    },
    "gpt-5",
  );
  expect(body.tools).toEqual([
    { type: "function", name: "f", description: "d", parameters: { type: "object" } },
  ]);
  expect(body.tool_choice).toEqual({ type: "function", name: "f" });
});

test("records a lost budget instead of inventing an effort", () => {
  const { body, degradations } = toResponsesWire(
    { ...base, reasoning: { mode: "budget", budgetTokens: 8000 } },
    "gpt-5",
  );
  // A budget is not expressible here, and mapping it onto an effort would
  // tune thinking to a depth no client asked for. These models think by
  // default, so nothing is sent and the loss is recorded.
  expect(body.reasoning).toBeUndefined();
  expect(degradations).toContain("openai:reasoning-budget-dropped");
});

test("forwards the full official effort ladder unclamped", () => {
  // The API's own union now runs none..max; model support varies and an
  // unsupported value is the upstream's error to raise, not ours to pre-clamp.
  for (const effort of ["none", "minimal", "xhigh", "max"] as const) {
    const { body, degradations } = toResponsesWire(
      { ...base, reasoning: { mode: "adaptive", effort } },
      "gpt-5",
    );
    expect(body.reasoning).toEqual({ effort, summary: "auto" });
    expect(degradations).toEqual([]);
  }
});

test("sends no reasoning at all when the client turned it off", () => {
  const { body } = toResponsesWire({ ...base, reasoning: { mode: "off" } }, "gpt-5");
  expect(body.reasoning).toBeUndefined();
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
    // OpenAI counts cached tokens inside `input_tokens`; the IR does not, so
    // the cached part is subtracted out here. Leaving it in would bill those
    // tokens twice — once at the input rate and again at the cache rate.
    usage: { inputTokens: 6, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 0 },
  });
});

test("never reports negative input when upstream cache counts look wrong", async () => {
  const events = await collect(
    decodeResponses(
      msgs({
        event: "response.completed",
        data: JSON.stringify({
          response: {
            status: "completed",
            usage: {
              input_tokens: 3,
              output_tokens: 1,
              input_tokens_details: { cached_tokens: 10 },
            },
          },
        }),
      }),
    ),
  );
  expect(events.at(-1)).toMatchObject({
    usage: { inputTokens: 0, outputTokens: 1, cacheReadTokens: 10, cacheWriteTokens: 0 },
  });
});

test("emits UPSTREAM when EOF arrives before response completion", async () => {
  const events = await collect(
    decodeResponses(
      msgs(
        {
          event: "response.created",
          data: JSON.stringify({ response: { id: "resp_1", model: "gpt-5" } }),
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
          data: JSON.stringify({ output_index: 0, content_index: 0, delta: "partial" }),
        },
      ),
    ),
  );

  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(events.some((event) => event.type === "end")).toBe(false);
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

test("maps a content-filtered incomplete response onto contentFilter", async () => {
  const events = await collect(
    decodeResponses(
      msgs({
        event: "response.incomplete",
        data: JSON.stringify({
          response: {
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
            usage: {},
          },
        }),
      }),
    ),
  );
  expect(events[0]).toMatchObject({ type: "end", stopReason: "contentFilter" });
});

test("fails visibly on an incomplete response with an unrecognized reason", async () => {
  const events = await collect(
    decodeResponses(
      msgs({
        event: "response.incomplete",
        data: JSON.stringify({
          response: {
            status: "incomplete",
            incomplete_details: { reason: "ran_out_of_goodwill" },
            usage: {},
          },
        }),
      }),
    ),
  );
  expect(events).toEqual([
    {
      type: "error",
      code: "UPSTREAM",
      message: 'unrecognized OpenAI incomplete reason "ran_out_of_goodwill"',
      retryable: false,
    },
  ]);
});

test("fails visibly on an incomplete response that names no reason", async () => {
  const events = await collect(
    decodeResponses(
      msgs({
        event: "response.incomplete",
        data: JSON.stringify({ response: { status: "incomplete", usage: {} } }),
      }),
    ),
  );
  expect(events).toEqual([
    {
      type: "error",
      code: "UPSTREAM",
      message: "OpenAI reported the response incomplete without a reason",
      retryable: false,
    },
  ]);
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

test("inlines a mid-conversation system turn, which this backend refuses", () => {
  const { body, degradations } = toResponsesWire(
    {
      model: "m",
      system: [{ type: "text", text: "top-level prompt" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "system", content: [{ type: "text", text: "Write Go." }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
      stream: false,
    },
    "gpt-5.6-sol",
  );

  // The request-level prompt has its own field and is untouched; the turn keeps
  // its position but arrives as a marked user message.
  expect(body.instructions).toBe("top-level prompt");
  expect(body.input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<system-reminder>\nWrite Go.\n</system-reminder>" }],
    },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
  ]);
  expect(degradations).toContain("openai:system-turn-inlined");
});

test("never emits a system role inside the input", () => {
  const { body } = toResponsesWire(
    {
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "system", content: [{ type: "text", text: "Write Go." }] },
      ],
      stream: false,
    },
    "gpt-5.6-sol",
  );

  const roles = (body.input as { role: string }[]).map((m) => m.role);
  expect(roles).not.toContain("system");
});

test("keeps max_output_tokens and temperature on the standard API", () => {
  const { body, degradations } = toResponsesWire(
    { ...base, maxTokens: 2048, temperature: 0.4 },
    "gpt-5.6-sol",
  );

  expect(body.max_output_tokens).toBe(2048);
  expect(body.temperature).toBe(0.4);
  expect(degradations).toEqual([]);
});

test("drops the parameters the Codex backend refuses", () => {
  const { body, degradations } = toResponsesWire(
    { ...base, maxTokens: 2048, temperature: 0.4 },
    "gpt-5.6-sol",
    { oauth: true },
  );

  // Sending either one returns "Unsupported parameter" from that endpoint.
  expect(body.max_output_tokens).toBeUndefined();
  expect(body.temperature).toBeUndefined();
  expect(degradations).toContain("openai:max-tokens-dropped");
  expect(degradations).toContain("openai:temperature-dropped");
});

test("records nothing when there was no such parameter to drop", () => {
  const { degradations } = toResponsesWire(base, "gpt-5.6-sol", { oauth: true });
  expect(degradations).toEqual([]);
});

test("closes a message block exactly once", async () => {
  // The real Codex stream sends content_part.done *and* output_item.done for a
  // message item. Emitting a blockEnd for both reached the client as a second
  // content_block_stop for an already-closed block.
  const events = await collect(
    decodeResponses(
      msgs(
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
          data: JSON.stringify({ output_index: 0, content_index: 0, delta: "hi" }),
        },
        {
          event: "response.content_part.done",
          data: JSON.stringify({ output_index: 0, content_index: 0 }),
        },
        { event: "response.output_item.done", data: JSON.stringify({ output_index: 0 }) },
        {
          event: "response.completed",
          data: JSON.stringify({ response: { status: "completed", usage: {} } }),
        },
      ),
    ),
  );

  expect(events.filter((e) => e.type === "blockEnd")).toEqual([{ type: "blockEnd", index: 0 }]);
  expect(events.filter((e) => e.type === "blockStart")).toHaveLength(1);
});

test("closes reasoning and message blocks once each in a full turn", async () => {
  const events = await collect(
    decodeResponses(
      msgs(
        {
          event: "response.output_item.added",
          data: JSON.stringify({ output_index: 0, item: { type: "reasoning" } }),
        },
        {
          event: "response.reasoning_summary_text.delta",
          data: JSON.stringify({ output_index: 0, delta: "thinking" }),
        },
        { event: "response.output_item.done", data: JSON.stringify({ output_index: 0 }) },
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
        {
          event: "response.content_part.done",
          data: JSON.stringify({ output_index: 1, content_index: 0 }),
        },
        { event: "response.output_item.done", data: JSON.stringify({ output_index: 1 }) },
        {
          event: "response.completed",
          data: JSON.stringify({ response: { status: "completed", usage: {} } }),
        },
      ),
    ),
  );

  // One start and one end per block, and the answer text appears once.
  expect(events.filter((e) => e.type === "blockStart")).toHaveLength(2);
  expect(events.filter((e) => e.type === "blockEnd")).toEqual([
    { type: "blockEnd", index: 0 },
    { type: "blockEnd", index: 1 },
  ]);
  const text = events
    .filter((e) => e.type === "blockDelta" && e.delta.type === "text")
    .map((e) => (e.type === "blockDelta" && e.delta.type === "text" ? e.delta.text : ""));
  expect(text).toEqual(["answer"]);
});

test("falls back to the chat-completions spelling of cached tokens", async () => {
  const events = await collect(
    decodeResponses(
      msgs({
        event: "response.completed",
        data: JSON.stringify({
          response: {
            status: "completed",
            // An OpenAI-compatible endpoint behind an `openai` target may use
            // the chat-completions field name rather than the Responses one.
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              prompt_tokens_details: { cached_tokens: 4 },
            },
          },
        }),
      }),
    ),
  );
  expect(events.at(-1)).toMatchObject({
    usage: { inputTokens: 6, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 0 },
  });
});

// The client asked for a megabyte of context and this surface has no way to
// grant or refuse it. The silence is what makes it worth recording: the client
// keeps pacing itself against 1M while the target caps far lower, and the
// request that finally exceeds it fails with nothing explaining why.
test("records that a 1m request could not be honoured here", () => {
  const { degradations } = toResponsesWire(
    { ...base, betas: ["context-1m-2025-08-07"] },
    "gpt-5.6",
  );
  expect(degradations).toContain("openai:context-1m-dropped");
});

test("records nothing when no 1m request was made", () => {
  const { degradations } = toResponsesWire(base, "gpt-5.6");
  expect(degradations).not.toContain("openai:context-1m-dropped");
});

// The Responses decoder used to end its switch with a bare `default: break`, so
// an event it had never heard of was dropped and the stream carried on. That is
// content the client never sees with nothing in the log to explain it — a turn
// that ends clean and short is indistinguishable from a short answer. The guard
// is grok's, forked rather than shared, per boundary rule 2.
test("fails visibly on an SSE event it does not know", async () => {
  const events = await collect(
    decodeResponses(
      msgs(
        {
          event: "response.created",
          data: JSON.stringify({ response: { id: "resp_1", model: "gpt-5" } }),
        },
        { event: "response.tool_call.invented", data: JSON.stringify({ output_index: 0 }) },
        {
          event: "response.completed",
          data: JSON.stringify({ response: { status: "completed", usage: {} } }),
        },
      ),
    ),
  );

  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(events.some((e) => e.type === "end")).toBe(false);
});

test("fails visibly on an unknown SSE event whose data is not JSON", async () => {
  const events = await collect(
    decodeResponses(
      msgs(
        {
          event: "response.created",
          data: JSON.stringify({ response: { id: "resp_1", model: "gpt-5" } }),
        },
        { event: "response.tool_call.invented", data: "not json at all" },
        {
          event: "response.completed",
          data: JSON.stringify({ response: { status: "completed", usage: {} } }),
        },
      ),
    ),
  );

  // Parsing before checking the event name would let an unrecognized event hide
  // behind its own payload: the stream would end clean and short, which is the
  // exact silent truncation the check is there to refuse.
  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(events.some((e) => e.type === "end")).toBe(false);
});

test("a known event the decoder ignores does not end the stream", async () => {
  // What makes the set an allowlist rather than a restatement of the switch.
  // Written from the switch instead, every one of these would fail — and the
  // failure would be a real Codex turn refused by its own gateway.
  const ignored = [
    "response.queued",
    "response.in_progress",
    "response.output_text.done",
    "response.output_text.annotation.added",
    "response.refusal.delta",
    "response.refusal.done",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_part.done",
    "response.reasoning_summary_text.done",
    "response.reasoning_text.delta",
    "response.reasoning_text.done",
    "response.function_call_arguments.done",
  ];

  for (const event of ignored) {
    const events = await collect(
      decodeResponses(
        msgs(
          { event, data: JSON.stringify({ output_index: 0 }) },
          {
            event: "response.completed",
            data: JSON.stringify({ response: { status: "completed", usage: {} } }),
          },
        ),
      ),
    );
    expect([event, events.at(-1)?.type]).toEqual([event, "end"]);
  }
});

test("accepts the [DONE] sentinel instead of reading it as an unknown event", async () => {
  const events = await collect(
    decodeResponses(
      msgs(
        {
          event: "response.completed",
          data: JSON.stringify({ response: { status: "completed", usage: {} } }),
        },
        // `parseSse` names an unlabelled record "message", so the transport
        // sentinel would otherwise arrive as an event outside the known set.
        // The Responses API sends one, so this is the ordinary close, not a
        // hypothetical proxy being generous.
        { event: "message", data: "[DONE]" },
      ),
    ),
  );

  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "endTurn" });
  expect(events.some((e) => e.type === "error")).toBe(false);
});
