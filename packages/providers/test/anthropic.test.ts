import { expect, test } from "bun:test";
import type { ChatRequest, StreamEvent } from "@omni/ir";
import { decodeAnthropic } from "../src/anthropic/decode.ts";
import { OAUTH_IDENTITY, toWire } from "../src/anthropic/wire.ts";
import type { SseMessage } from "../src/sse.ts";

const base: ChatRequest = {
  model: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

async function* msgs(...m: SseMessage[]): AsyncGenerator<SseMessage> {
  for (const x of m) yield x;
}

async function collectEvents(g: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
}

test("maps messages and model onto the wire body", () => {
  const { body } = toWire(base, "claude-opus-4", { oauth: false });
  expect(body.model).toBe("claude-opus-4");
  expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  expect(body.stream).toBe(true);
  expect(body.max_tokens).toBe(4096);
});

test("passes the system prompt through as blocks", () => {
  const { body } = toWire(
    { ...base, system: [{ type: "text", text: "be terse" }] },
    "claude-opus-4",
    { oauth: false },
  );
  expect(body.system).toEqual([{ type: "text", text: "be terse" }]);
});

test("prepends the required identity block on the oauth path and records it", () => {
  const { body, degradations } = toWire(
    { ...base, system: [{ type: "text", text: "be terse" }] },
    "claude-opus-4",
    { oauth: true },
  );
  expect(body.system?.[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  expect(body.system?.[1]?.text).toBe("be terse");
  expect(degradations).toContain("anthropic:oauth-system-prefix");
});

test("does not duplicate the identity block when the caller already sent it", () => {
  const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
  const { body, degradations } = toWire(
    { ...base, system: [{ type: "text", text: identity }] },
    "m",
    {
      oauth: true,
    },
  );
  expect(body.system).toHaveLength(1);
  expect(degradations).not.toContain("anthropic:oauth-system-prefix");
});

test("translates tools and tool choice", () => {
  const { body } = toWire(
    {
      ...base,
      tools: [{ name: "get_weather", description: "d", inputSchema: { type: "object" } }],
      toolChoice: { type: "tool", name: "get_weather" },
    },
    "m",
    { oauth: false },
  );
  expect(body.tools).toEqual([
    { name: "get_weather", description: "d", input_schema: { type: "object" } },
  ]);
  expect(body.tool_choice).toEqual({ type: "tool", name: "get_weather" });
});

test("sends a client-named budget verbatim", () => {
  const { body } = toWire({ ...base, reasoning: { mode: "budget", budgetTokens: 8000 } }, "m", {
    oauth: false,
  });
  expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
  expect(body.output_config).toBeUndefined();
});

test("renders adaptive thinking with effort as an output control", () => {
  const { body } = toWire(
    { ...base, reasoning: { mode: "adaptive", effort: "xhigh", display: "summarized" } },
    "m",
    { oauth: false },
  );
  // Never a budget: that form is rejected by current models, so an effort
  // level must not be turned into one.
  expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  expect(body.output_config).toEqual({ effort: "xhigh" });
});

test("passes an explicit opt-out through instead of dropping it", () => {
  const { body } = toWire({ ...base, reasoning: { mode: "off" } }, "m", { oauth: false });
  // Omitting `thinking` is not equivalent — several models think by default.
  expect(body.thinking).toEqual({ type: "disabled" });
});

test("merges vendor passthrough last so it can override", () => {
  const { body } = toWire({ ...base, vendor: { anthropic: { top_k: 40 } } }, "m", { oauth: false });
  expect(body.top_k).toBe(40);
});

test("renders a cache breakpoint on a system block, ttl and all", () => {
  const { body } = toWire(
    {
      ...base,
      system: [{ type: "text", text: "be terse", cacheControl: { type: "ephemeral", ttl: "1h" } }],
    },
    "m",
    { oauth: false },
  );
  expect(body.system).toEqual([
    { type: "text", text: "be terse", cache_control: { type: "ephemeral", ttl: "1h" } },
  ]);
});

test("omits an absent ttl rather than inventing one", () => {
  const { body } = toWire(
    { ...base, system: [{ type: "text", text: "be terse", cacheControl: { type: "ephemeral" } }] },
    "m",
    { oauth: false },
  );
  expect(body.system).toEqual([
    { type: "text", text: "be terse", cache_control: { type: "ephemeral" } },
  ]);
});

test("renders a cache breakpoint on the message block that carried it", () => {
  const { body } = toWire(
    {
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "stable", cacheControl: { type: "ephemeral" } },
            { type: "text", text: "volatile" },
          ],
        },
      ],
    },
    "m",
    { oauth: false },
  );
  expect(body.messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
        { type: "text", text: "volatile" },
      ],
    },
  ]);
});

test("renders a cache breakpoint on a tool definition", () => {
  const { body } = toWire(
    {
      ...base,
      tools: [
        {
          name: "f",
          inputSchema: { type: "object" },
          cacheControl: { type: "ephemeral", ttl: "1h" },
        },
      ],
    },
    "m",
    { oauth: false },
  );
  expect(body.tools).toEqual([
    {
      name: "f",
      input_schema: { type: "object" },
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ]);
});

test("leaves the caller's breakpoint on its own block after the oauth prefix", () => {
  const { body } = toWire(
    {
      ...base,
      system: [{ type: "text", text: "be terse", cacheControl: { type: "ephemeral" } }],
    },
    "m",
    { oauth: true },
  );
  // The prefix is ours, not the caller's: marking it would move the breakpoint
  // and change what the caller asked to cache.
  expect(body.system?.[0]).toEqual({ type: "text", text: OAUTH_IDENTITY });
  expect(body.system?.[1]).toEqual({
    type: "text",
    text: "be terse",
    cache_control: { type: "ephemeral" },
  });
});

test("records a degradation when a system turn's breakpoint cannot survive flattening", () => {
  const { body, degradations } = toWire(
    {
      ...base,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "system",
          content: [{ type: "text", text: "Write Go.", cacheControl: { type: "ephemeral" } }],
        },
      ],
    },
    "m",
    { oauth: false },
  );
  // The turn is a plain string on the wire, so a block-level marker has nowhere
  // to go. Dropping it silently would hide a caching intent that never took.
  expect(body.messages?.[1]).toEqual({ role: "system", content: "Write Go." });
  expect(degradations).toContain("anthropic:system-turn-cache-control-dropped");
});

test("leaves an unmarked system turn free of degradations", () => {
  const { degradations } = toWire(
    {
      ...base,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "system", content: [{ type: "text", text: "Write Go." }] },
      ],
    },
    "m",
    { oauth: false },
  );
  expect(degradations).not.toContain("anthropic:system-turn-cache-control-dropped");
});

test("decodes upstream cache counters into canonical usage", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs(
        {
          event: "message_start",
          data: JSON.stringify({
            message: {
              id: "msg_1",
              model: "claude-opus-4",
              usage: {
                input_tokens: 10,
                cache_read_input_tokens: 4000,
                cache_creation_input_tokens: 120,
              },
            },
          }),
        },
        {
          event: "message_delta",
          data: JSON.stringify({ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
        },
        { event: "message_stop", data: "{}" },
      ),
    ),
  );

  expect(events.at(-1)).toEqual({
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4000, cacheWriteTokens: 120 },
  });
});

test("decodes a text stream into canonical events", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs(
        {
          event: "message_start",
          data: JSON.stringify({
            message: { id: "msg_1", model: "claude-opus-4", usage: { input_tokens: 10 } },
          }),
        },
        {
          event: "content_block_start",
          data: JSON.stringify({ index: 0, content_block: { type: "text", text: "" } }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({ index: 0, delta: { type: "text_delta", text: "Hel" } }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({ index: 0, delta: { type: "text_delta", text: "lo" } }),
        },
        { event: "content_block_stop", data: JSON.stringify({ index: 0 }) },
        {
          event: "message_delta",
          data: JSON.stringify({
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          }),
        },
        { event: "message_stop", data: "{}" },
      ),
    ),
  );

  expect(events[0]).toEqual({ type: "start", id: "msg_1", model: "claude-opus-4" });
  expect(events[1]).toEqual({ type: "blockStart", index: 0, block: { type: "text" } });
  expect(events[2]).toEqual({ type: "blockDelta", index: 0, delta: { type: "text", text: "Hel" } });
  expect(events.at(-1)).toEqual({
    type: "end",
    stopReason: "endTurn",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  });
});

test("emits UPSTREAM when EOF arrives before message_stop", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs(
        {
          event: "message_start",
          data: JSON.stringify({ message: { id: "msg_1", model: "claude-opus-4" } }),
        },
        {
          event: "content_block_start",
          data: JSON.stringify({ index: 0, content_block: { type: "text" } }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({ index: 0, delta: { type: "text_delta", text: "partial" } }),
        },
      ),
    ),
  );

  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(events.some((event) => event.type === "end")).toBe(false);
});

test("decodes tool use with partial json deltas", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs(
        {
          event: "content_block_start",
          data: JSON.stringify({
            index: 1,
            content_block: { type: "tool_use", id: "tu_1", name: "get_weather" },
          }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"city":' },
          }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({
            index: 1,
            delta: { type: "input_json_delta", partial_json: '"SF"}' },
          }),
        },
        { event: "content_block_stop", data: JSON.stringify({ index: 1 }) },
        { event: "message_stop", data: "{}" },
      ),
    ),
  );

  expect(events[0]).toEqual({
    type: "blockStart",
    index: 1,
    block: { type: "toolUse", id: "tu_1", name: "get_weather" },
  });
  expect(events[1]).toEqual({
    type: "blockDelta",
    index: 1,
    delta: { type: "toolJson", partial: '{"city":' },
  });
  expect(events.at(-2)).toEqual({ type: "blockEnd", index: 1 });
  expect(events.at(-1)).toMatchObject({ type: "end" });
});

test("decodes thinking deltas and signatures", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs(
        {
          event: "content_block_start",
          data: JSON.stringify({ index: 0, content_block: { type: "thinking" } }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({ index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({ index: 0, delta: { type: "signature_delta", signature: "sig" } }),
        },
      ),
    ),
  );
  expect(events[1]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "thinking", text: "hmm" },
  });
  expect(events[2]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "thinkingSignature", signature: "sig" },
  });
});

test("turns a mid-stream error event into an error event", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs({
        event: "error",
        data: JSON.stringify({ error: { type: "overloaded_error", message: "overloaded" } }),
      }),
    ),
  );
  expect(events[0]).toEqual({
    type: "error",
    code: "OVERLOADED",
    message: "overloaded",
    retryable: true,
  });
});

test("ignores ping events but rejects an unparseable terminal payload", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs({ event: "ping", data: "{}" }, { event: "message_stop", data: "not-json" }),
    ),
  );
  expect(events).toEqual([
    {
      type: "error",
      code: "UPSTREAM",
      message: "upstream stream ended before message_stop",
      retryable: true,
    },
  ]);
});

test("renders a mid-conversation system turn as the documented string form", () => {
  const { body } = toWire(
    {
      model: "m",
      system: [{ type: "text", text: "top-level prompt" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "system", content: [{ type: "text", text: "Write Go." }] },
      ],
      stream: false,
    },
    "claude-opus-5",
    { oauth: false },
  );

  // The request-level prompt stays in `system`; the turn stays in `messages`,
  // in position, as a plain string rather than a block array.
  expect(body.system).toEqual([{ type: "text", text: "top-level prompt" }]);
  expect(body.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "system", content: "Write Go." },
  ]);
});

test("splits cache creation by ttl so each write prices at its own rate", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs(
        {
          event: "message_start",
          data: JSON.stringify({
            message: {
              id: "msg_1",
              model: "claude-opus-4",
              usage: {
                input_tokens: 10,
                cache_read_input_tokens: 1800,
                cache_creation_input_tokens: 248,
                cache_creation: {
                  ephemeral_5m_input_tokens: 148,
                  ephemeral_1h_input_tokens: 100,
                },
              },
            },
          }),
        },
        {
          event: "message_delta",
          data: JSON.stringify({ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
        },
        { event: "message_stop", data: "{}" },
      ),
    ),
  );

  // A 5m write bills at 1.25x input and a 1h write at 2x, so the aggregate
  // alone cannot be priced. The breakdown sums to it.
  expect(events.at(-1)).toEqual({
    type: "end",
    stopReason: "endTurn",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 1800,
      cacheWriteTokens: 248,
      cacheWrite5mTokens: 148,
      cacheWrite1hTokens: 100,
    },
  });
});

test("leaves the ttl split off when the upstream reports no breakdown", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs(
        {
          event: "message_start",
          data: JSON.stringify({
            message: {
              id: "msg_1",
              model: "claude-opus-4",
              usage: { input_tokens: 10, cache_creation_input_tokens: 248 },
            },
          }),
        },
        { event: "message_stop", data: "{}" },
      ),
    ),
  );
  const end = events.at(-1);
  expect(end).toMatchObject({ usage: { cacheWriteTokens: 248 } });
  // Absent, not zero: "not told" and "no 1h writes" price the same today but
  // are different facts, and `exactOptionalPropertyTypes` keeps them apart.
  expect(end).not.toHaveProperty("usage.cacheWrite5mTokens");
  expect(end).not.toHaveProperty("usage.cacheWrite1hTokens");
});

test("records a dropped system-turn breakpoint once, however many turns carried one", () => {
  const marked = {
    role: "system" as const,
    content: [{ type: "text" as const, text: "x", cacheControl: { type: "ephemeral" as const } }],
  };
  const { degradations } = toWire(
    {
      ...base,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }, marked, marked],
    },
    "m",
    { oauth: false },
  );
  // A degradation names a thing the request lost, not how many times the
  // encoder noticed. The other two encoders dedupe; this one should read the
  // same in a request log.
  expect(degradations.filter((d) => d === "anthropic:system-turn-cache-control-dropped")).toEqual([
    "anthropic:system-turn-cache-control-dropped",
  ]);
});
