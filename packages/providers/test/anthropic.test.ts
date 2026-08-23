import { expect, test } from "bun:test";
import type { ChatRequest, StreamEvent } from "@omni/ir";
import { GatewayError } from "@omni/ir";
import { decodeAnthropic } from "../src/anthropic/decode.ts";
import { anthropicAdapter } from "../src/anthropic/index.ts";
import { OAUTH_IDENTITY, toWire } from "../src/anthropic/wire.ts";
import type { SseMessage } from "../src/sse.ts";
import type { AdapterRequest, AdapterResult, HttpRequest } from "../src/types.ts";

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
      tools: [
        {
          provider: "custom",
          name: "get_weather",
          description: "d",
          inputSchema: { type: "object" },
        },
      ],
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

test("downgrades adaptive thinking on a model that only speaks the budget form", () => {
  const { body, degradations } = toWire(
    { ...base, reasoning: { mode: "adaptive", effort: "xhigh" } },
    "claude-haiku-4-5",
    { oauth: false },
  );
  // The alternative is a 400 upstream. Effort goes with it rather than becoming
  // a budget the client never asked for.
  expect(body.thinking).toEqual({ type: "disabled" });
  expect(body.output_config).toBeUndefined();
  expect(degradations).toContain("anthropic:adaptive-thinking-unsupported");
});

test("resolves dated and 1M-suffixed spellings of a budget-form model the same way", () => {
  for (const model of ["claude-haiku-4-5-20251001", "claude-haiku-4-5[1m]"]) {
    const { body, degradations } = toWire({ ...base, reasoning: { mode: "adaptive" } }, model, {
      oauth: false,
    });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(degradations).toContain("anthropic:adaptive-thinking-unsupported");
  }
});

test("leaves an explicit budget and an explicit opt-out alone on a budget-form model", () => {
  const budget = toWire(
    { ...base, reasoning: { mode: "budget", budgetTokens: 8000 } },
    "claude-haiku-4-5",
    { oauth: false },
  );
  expect(budget.body.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
  expect(budget.degradations).toEqual([]);

  const off = toWire({ ...base, reasoning: { mode: "off" } }, "claude-haiku-4-5", {
    oauth: false,
  });
  expect(off.body.thinking).toEqual({ type: "disabled" });
  expect(off.degradations).toEqual([]);
});

test("drops an effort a budget-form model cannot express, downgrade or not", () => {
  // No `reasoning` at all: the strip does not depend on the thinking downgrade
  // having fired.
  const { body, degradations } = toWire(
    { ...base, vendor: { anthropic: { output_config: { effort: "high" } } } },
    "claude-haiku-4-5",
    { oauth: false },
  );
  expect(body.output_config).toBeUndefined();
  expect(degradations).toContain("anthropic:effort-unsupported");
});

test("keeps the rest of an output_config when only effort is unsupported", () => {
  const { body, degradations } = toWire(
    {
      ...base,
      vendor: { anthropic: { output_config: { effort: "high", format: { type: "json_schema" } } } },
    },
    "claude-haiku-4-5",
    { oauth: false },
  );
  expect(body.output_config).toEqual({ format: { type: "json_schema" } });
  expect(degradations).toContain("anthropic:effort-unsupported");
});

test("leaves vendor effort alone on a model that accepts it", () => {
  const { body, degradations } = toWire(
    { ...base, vendor: { anthropic: { output_config: { effort: "high" } } } },
    "claude-opus-5",
    { oauth: false },
  );
  expect(body.output_config).toEqual({ effort: "high" });
  expect(degradations).toEqual([]);
});

test("passes a non-object output_config through rather than rewriting it", () => {
  const { body, degradations } = toWire(
    { ...base, vendor: { anthropic: { output_config: "effort" } } },
    "claude-haiku-4-5",
    { oauth: false },
  );
  expect(body.output_config).toBe("effort");
  expect(degradations).toEqual([]);
});

test("strips an effort a client sent without any thinking field", () => {
  // What ingress produces from `output_config.effort` alone: reasoning is
  // synthesized as adaptive, and the raw object still rides along in vendor.
  const { body, degradations } = toWire(
    {
      ...base,
      reasoning: { mode: "adaptive", effort: "high" },
      vendor: { anthropic: { output_config: { effort: "high" } } },
    },
    "claude-haiku-4-5",
    { oauth: false },
  );
  expect(body.thinking).toEqual({ type: "disabled" });
  expect(body.output_config).toBeUndefined();
  expect(degradations).toEqual([
    "anthropic:adaptive-thinking-unsupported",
    "anthropic:effort-unsupported",
  ]);
});

test("lets vendor passthrough override the adaptive-thinking downgrade", () => {
  const { body } = toWire(
    {
      ...base,
      reasoning: { mode: "adaptive" },
      vendor: { anthropic: { thinking: { type: "enabled", budget_tokens: 2048 } } },
    },
    "claude-haiku-4-5",
    { oauth: false },
  );
  expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
});

test("merges vendor passthrough last so it can override", () => {
  const { body } = toWire({ ...base, vendor: { anthropic: { top_k: 40 } } }, "m", { oauth: false });
  expect(body.top_k).toBe(40);
});

const clearThinking = { type: "clear_thinking_20251015" };
const clearToolUses = { type: "clear_tool_uses_20250919" };

test("drops a clear_thinking edit when the downgrade turned thinking off", () => {
  // What Claude Code sends against a haiku target: adaptive thinking plus a
  // context edit that upstream rejects unless thinking is on.
  const { body, degradations } = toWire(
    {
      ...base,
      reasoning: { mode: "adaptive" },
      vendor: { anthropic: { context_management: { edits: [clearThinking] } } },
    },
    "claude-haiku-4-5",
    { oauth: false },
  );
  expect(body.thinking).toEqual({ type: "disabled" });
  // Nothing left to edit, so the container goes rather than being sent empty.
  expect(body.context_management).toBeUndefined();
  expect(degradations).toContain("anthropic:clear-thinking-unsupported");
});

test("keeps the other edits when only clear_thinking is unsupported", () => {
  const { body, degradations } = toWire(
    {
      ...base,
      reasoning: { mode: "adaptive" },
      vendor: {
        anthropic: { context_management: { edits: [clearToolUses, clearThinking], other: 1 } },
      },
    },
    "claude-haiku-4-5",
    { oauth: false },
  );
  expect(body.context_management).toEqual({ edits: [clearToolUses], other: 1 });
  expect(degradations).toContain("anthropic:clear-thinking-unsupported");
});

test("drops a clear_thinking edit a client paired with its own opt-out", () => {
  // Not a downgrade: the client asked for thinking off itself, on a model that
  // has no trouble with the adaptive form.
  const { body, degradations } = toWire(
    {
      ...base,
      reasoning: { mode: "off" },
      vendor: { anthropic: { context_management: { edits: [clearThinking] } } },
    },
    "claude-opus-5",
    { oauth: false },
  );
  expect(body.context_management).toBeUndefined();
  expect(degradations).toContain("anthropic:clear-thinking-unsupported");
});

test("leaves a clear_thinking edit alone while thinking is on", () => {
  for (const model of ["claude-opus-5", "claude-haiku-4-5"]) {
    const { body, degradations } = toWire(
      {
        ...base,
        // Budget form on haiku, adaptive on opus: both are thinking-on.
        reasoning:
          model === "claude-haiku-4-5"
            ? { mode: "budget", budgetTokens: 8000 }
            : { mode: "adaptive" },
        vendor: { anthropic: { context_management: { edits: [clearThinking] } } },
      },
      model,
      { oauth: false },
    );
    expect(body.context_management).toEqual({ edits: [clearThinking] });
    expect(degradations).toEqual([]);
  }
});

test("keeps a clear_thinking edit when vendor passthrough re-enables thinking", () => {
  // Passthrough outranks the mapping, so the strip reads the merged body rather
  // than the downgrade decision that preceded it.
  const { body, degradations } = toWire(
    {
      ...base,
      reasoning: { mode: "adaptive" },
      vendor: {
        anthropic: {
          thinking: { type: "enabled", budget_tokens: 2048 },
          context_management: { edits: [clearThinking] },
        },
      },
    },
    "claude-haiku-4-5",
    { oauth: false },
  );
  expect(body.context_management).toEqual({ edits: [clearThinking] });
  expect(degradations).not.toContain("anthropic:clear-thinking-unsupported");
});

test("leaves a clear_thinking edit alone when no thinking field is sent at all", () => {
  // No `reasoning` means no `thinking` key on the body, which is the provider
  // default rather than an opt-out — the gateway does not decide it for them.
  const { body, degradations } = toWire(
    { ...base, vendor: { anthropic: { context_management: { edits: [clearThinking] } } } },
    "claude-opus-5",
    { oauth: false },
  );
  expect(body.context_management).toEqual({ edits: [clearThinking] });
  expect(degradations).toEqual([]);
});

test("passes a context_management this encoder cannot read through unchanged", () => {
  for (const value of ["edits", { edits: "all" }]) {
    const { body, degradations } = toWire(
      {
        ...base,
        reasoning: { mode: "off" },
        vendor: { anthropic: { context_management: value } },
      },
      "claude-opus-5",
      { oauth: false },
    );
    expect(body.context_management).toEqual(value);
    expect(degradations).toEqual([]);
  }
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
          provider: "custom",
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

test("promotes a final system-turn breakpoint to automatic caching", () => {
  const { body, degradations } = toWire(
    {
      ...base,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "Write Go.",
              cacheControl: { type: "ephemeral", ttl: "1h" },
            },
          ],
        },
      ],
    },
    "m",
    { oauth: false },
  );
  expect(body.messages?.[1]).toEqual({ role: "system", content: "Write Go." });
  expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(degradations).not.toContain("anthropic:system-turn-cache-control-dropped");
});

test("keeps degradation when content follows a marked system turn", () => {
  const { body, degradations } = toWire(
    {
      ...base,
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "Write Go.", cacheControl: { type: "ephemeral" } }],
        },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    },
    "m",
    { oauth: false },
  );
  expect(body.cache_control).toBeUndefined();
  expect(degradations).toContain("anthropic:system-turn-cache-control-dropped");
});

test("lets vendor passthrough override a promoted system-turn breakpoint", () => {
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
      vendor: { anthropic: { cache_control: { type: "ephemeral", ttl: "1h" } } },
    },
    "m",
    { oauth: false },
  );
  expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(degradations).not.toContain("anthropic:system-turn-cache-control-dropped");
});

test("leaves an unmarked system turn free of degradations", () => {
  const { body, degradations } = toWire(
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
  expect(body.cache_control).toBeUndefined();
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

test("promotes the final system-turn breakpoint and records earlier losses once", () => {
  const { body, degradations } = toWire(
    {
      ...base,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "system",
          content: [
            { type: "text", text: "first", cacheControl: { type: "ephemeral" } },
            { type: "text", text: "last", cacheControl: { type: "ephemeral", ttl: "1h" } },
          ],
        },
      ],
    },
    "m",
    { oauth: false },
  );
  expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(degradations.filter((d) => d === "anthropic:system-turn-cache-control-dropped")).toEqual([
    "anthropic:system-turn-cache-control-dropped",
  ]);
});

test("promotes the final marker across several marked system turns", () => {
  const { body, degradations } = toWire(
    {
      ...base,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "system",
          content: [{ type: "text", text: "first", cacheControl: { type: "ephemeral" } }],
        },
        {
          role: "system",
          content: [{ type: "text", text: "last", cacheControl: { type: "ephemeral", ttl: "1h" } }],
        },
      ],
    },
    "m",
    { oauth: false },
  );
  expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(degradations).toContain("anthropic:system-turn-cache-control-dropped");
});

test("drops an unsigned thinking block and records the loss", () => {
  const { body, degradations } = toWire(
    {
      ...base,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "reasoning from another provider" },
            { type: "text", text: "hello" },
          ],
        },
      ],
    },
    "claude-opus-4",
    { oauth: false },
  );
  expect(body.messages[1]).toEqual({
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
  });
  expect(degradations).toContain("anthropic:unsigned-thinking-dropped");
});

test("drops a thinking block whose signature is empty", () => {
  const { body, degradations } = toWire(
    {
      ...base,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "hm", signature: "" },
            { type: "text", text: "hello" },
          ],
        },
      ],
    },
    "claude-opus-4",
    { oauth: false },
  );
  expect(body.messages[1]).toEqual({
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
  });
  expect(degradations).toContain("anthropic:unsigned-thinking-dropped");
});

test("keeps a signed thinking block", () => {
  const { body, degradations } = toWire(
    {
      ...base,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [{ type: "thinking", text: "hm", signature: "sig" }],
        },
      ],
    },
    "claude-opus-4",
    { oauth: false },
  );
  expect(body.messages[1]).toEqual({
    role: "assistant",
    content: [{ type: "thinking", thinking: "hm", signature: "sig" }],
  });
  expect(degradations).not.toContain("anthropic:unsigned-thinking-dropped");
});

test("drops a message left with no content by an unsigned thinking block", () => {
  const { body } = toWire(
    {
      ...base,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "thinking", text: "hm" }] },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
    },
    "claude-opus-4",
    { oauth: false },
  );
  expect(body.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "again" }] },
  ]);
});

test("marks decoded thinking blocks as signed", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs({
        event: "content_block_start",
        data: JSON.stringify({ index: 0, content_block: { type: "thinking" } }),
      }),
    ),
  );
  expect(events[0]).toEqual({
    type: "blockStart",
    index: 0,
    block: { type: "thinking", signed: true },
  });
});

test("ignores a signature delta that carries no signature", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs({
        event: "content_block_delta",
        data: JSON.stringify({ index: 0, delta: { type: "signature_delta" } }),
      }),
    ),
  );
  expect(events.filter((e) => e.type === "blockDelta")).toEqual([]);
});

/** Runs the adapter against a stub transport and hands back the exact bytes. */
async function capture(over: Partial<AdapterRequest> = {}): Promise<HttpRequest> {
  let sent: HttpRequest | null = null;
  await anthropicAdapter.send({
    request: base,
    model: "claude-opus-4",
    credentials: { accessToken: "oauth-token", apiKey: null, providerData: {} },
    signal: new AbortController().signal,
    ...over,
    http: async (request) => {
      sent = request;
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({ start: (controller) => controller.close() }),
        text: async () => "",
      };
    },
  });
  if (sent === null) throw new Error("adapter did not send a request");
  return sent;
}

/** The three signatures measured against the live API on 2026-08-22. */
const MEASURED_SIGNATURES = [
  "delegate_task",
  "session_search",
  "clarify",
  "skill_manage",
  "skill_view",
  "skills_list",
];

const WITH_SIGNATURES: ChatRequest = {
  ...base,
  messages: [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [{ type: "toolUse", id: "tu_1", name: "delegate_task", input: {} }],
    },
    { role: "user", content: [{ type: "toolResult", toolUseId: "tu_1", content: "ok" }] },
  ],
  tools: MEASURED_SIGNATURES.map((name) => ({
    provider: "custom" as const,
    name,
    inputSchema: { type: "object" },
  })),
  toolChoice: { type: "tool", name: "clarify" },
};

test("no measured fingerprint signature reaches the wire on the oauth path", async () => {
  const sent = await capture({ request: WITH_SIGNATURES });
  for (const name of MEASURED_SIGNATURES) {
    expect(sent.body).not.toContain(`"${name}"`);
  }
  // And the aliases really are there, so the assertion above cannot pass by the
  // tools having been dropped entirely.
  for (const alias of ["DelegateTask", "SessionSearch", "Clarify", "SkillManage", "SkillsList"]) {
    expect(sent.body).toContain(`"${alias}"`);
  }
});

test("the api-key path sends the client's own tool names untouched", async () => {
  const sent = await capture({
    request: WITH_SIGNATURES,
    credentials: { accessToken: null, apiKey: "sk-ant-test", providerData: {} },
  });
  // That surface does not fingerprint, so mutating its bodies buys nothing.
  for (const name of MEASURED_SIGNATURES) {
    expect(sent.body).toContain(`"${name}"`);
  }
  expect(sent.body).not.toContain("DelegateTask");
});

/**
 * The refusal as it was actually measured: an HTTP 400 with a JSON body, before
 * any stream begins.
 *
 * The adapter asks for `text/event-stream`, but a request-validation refusal is
 * answered before there is a stream to put an `error` event in, so this never
 * reaches the SSE decoder. Classifying it in the decoder alone would leave the
 * one shape the investigation actually recorded reading as `BAD_REQUEST`.
 */
async function sendRefused(body: string, status = 400): Promise<unknown> {
  try {
    await anthropicAdapter.send({
      request: base,
      model: "claude-opus-4",
      credentials: { accessToken: "oauth-token", apiKey: null, providerData: {} },
      signal: new AbortController().signal,
      http: async () => ({
        status,
        headers: new Headers({ "content-type": "application/json" }),
        body: null,
        text: async () => body,
      }),
    });
  } catch (error) {
    return error;
  }
  throw new Error("adapter did not throw");
}

const REFUSAL_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
  },
});

test("a fingerprint refusal arriving as an http 400 is named, not read as a bad request", async () => {
  const error = await sendRefused(REFUSAL_BODY);
  expect(error).toBeInstanceOf(GatewayError);
  expect((error as GatewayError).code).toBe("FINGERPRINT_REFUSED");
  expect((error as GatewayError).retryable).toBe(false);
  // The upstream's own words, forwarded.
  expect((error as GatewayError).message).toContain("out of extra usage");
  // The degradations ride the throw, because there is no result to carry them
  // and this is the failure whose diagnosis needs them.
  expect((error as GatewayError).degradations).toContain("anthropic:oauth-system-prefix");
});

test("only a 400 is read as a fingerprint refusal, whatever the message says", async () => {
  // The status stands in for the `type` the SSE route checks, so it is the
  // whole gate on this path. `codeForStatus` maps 413 and 422 to `BAD_REQUEST`
  // as well, and a 429 is a real limit: widening this to `>= 400` would turn a
  // rate limit carrying the same wording into a non-retryable refusal and end
  // the request against a pool that would have served it.
  for (const [status, expected] of [
    [429, "RATE_LIMIT"],
    [422, "BAD_REQUEST"],
    [500, "UPSTREAM"],
  ] as const) {
    const error = await sendRefused(REFUSAL_BODY, status);
    expect((error as GatewayError).code).toBe(expected);
  }
});

test("a refusal forwards the upstream's own status and retry hint", async () => {
  const error = await sendRefused(REFUSAL_BODY);
  expect((error as GatewayError).upstreamStatus).toBe(400);
});

test("an ordinary anthropic 400 is still a bad request", async () => {
  const error = await sendRefused(
    JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "max_tokens: must be >= 1" },
    }),
  );
  expect((error as GatewayError).code).toBe("BAD_REQUEST");
});

/** Runs the adapter against an empty 200 and hands back the whole result. */
async function sendResult(over: Partial<AdapterRequest> = {}): Promise<AdapterResult> {
  return anthropicAdapter.send({
    request: base,
    model: "claude-opus-4",
    credentials: { accessToken: "oauth-token", apiKey: null, providerData: {} },
    signal: new AbortController().signal,
    ...over,
    http: async () => ({
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: new ReadableStream({ start: (controller) => controller.close() }),
      text: async () => "",
    }),
  });
}

test("a cloaked request reports how many names it renamed, and records the loss", async () => {
  const result = await sendResult({ request: WITH_SIGNATURES });
  // A count, never the names: tool names are client free text.
  expect(result.cloakedTools).toBe(6);
  expect(result.degradations).toContain("anthropic:tool-names-cloaked");
});

test("an uncloaked request reports no count at all", async () => {
  const apiKey = await sendResult({
    request: WITH_SIGNATURES,
    credentials: { accessToken: null, apiKey: "sk-ant-test", providerData: {} },
  });
  expect(apiKey.cloakedTools).toBeUndefined();

  const noTools = await sendResult();
  expect(noTools.cloakedTools).toBeUndefined();
});

/**
 * A prompt over the minimum cacheable size, built from repeated text.
 *
 * The gate is a token estimate, and the estimator counts roughly four
 * characters to the token, so this has to be big in characters to be big in
 * tokens. Anything shorter would be skipped for a reason the test is not about.
 */
const BIG_SYSTEM = "You are a careful assistant. ".repeat(400);

/** A request with a cacheable prefix and no breakpoint anywhere — hermes' shape. */
const UNMARKED: ChatRequest = {
  ...base,
  system: [{ type: "text", text: BIG_SYSTEM }],
  tools: [{ provider: "custom", name: "session_search", inputSchema: { type: "object" } }],
};

test("adds a breakpoint to the last system block when the client sent none", () => {
  const { body, degradations } = toWire(UNMARKED, "m", { oauth: false, autoCache: true });
  expect(body.system?.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
  // The stable prefix only. A breakpoint on the volatile turn would be
  // rewritten every request and cache nothing.
  expect(JSON.stringify(body.messages)).not.toContain("cache_control");
  expect(degradations).toContain("anthropic:cache-breakpoint-added");
});

test("leaves the body untouched when the feature is off", () => {
  const off = toWire(UNMARKED, "m", { oauth: false });
  const on = toWire(UNMARKED, "m", { oauth: false, autoCache: false });
  expect(JSON.stringify(off.body)).not.toContain("cache_control");
  expect(JSON.stringify(on.body)).toBe(JSON.stringify(off.body));
});

test("never touches a request that already marks a breakpoint of its own", () => {
  // Anthropic caps breakpoints at four, and a client that placed its own knows
  // where its prefix ends better than this does. Byte-identical is the
  // assertion, not merely "still has one".
  const marked: ChatRequest = {
    ...UNMARKED,
    system: [{ type: "text", text: BIG_SYSTEM, cacheControl: { type: "ephemeral", ttl: "1h" } }],
  };
  const on = toWire(marked, "m", { oauth: false, autoCache: true });
  const off = toWire(marked, "m", { oauth: false });
  expect(JSON.stringify(on.body)).toBe(JSON.stringify(off.body));
  expect(on.degradations).not.toContain("anthropic:cache-breakpoint-added");
});

test("a marker anywhere at all counts, including on a tool", () => {
  const marked: ChatRequest = {
    ...UNMARKED,
    tools: [
      {
        provider: "custom",
        name: "session_search",
        inputSchema: { type: "object" },
        cacheControl: { type: "ephemeral" },
      },
    ],
  };
  const { body, degradations } = toWire(marked, "m", { oauth: false, autoCache: true });
  expect(body.system?.at(-1)?.cache_control).toBeUndefined();
  expect(degradations).not.toContain("anthropic:cache-breakpoint-added");
});

test("skips a prompt too small for Anthropic to cache", () => {
  // Below the minimum nothing caches however it is marked, so marking it would
  // record a change that bought nothing.
  const { body, degradations } = toWire(
    { ...base, system: [{ type: "text", text: "be terse" }] },
    "m",
    { oauth: false, autoCache: true },
  );
  expect(JSON.stringify(body)).not.toContain("cache_control");
  expect(degradations).not.toContain("anthropic:cache-breakpoint-added");
});

test("falls back to the last tool when the request carries no system prompt", () => {
  const toolsOnly: ChatRequest = {
    ...base,
    tools: [
      { provider: "custom", name: "a", description: BIG_SYSTEM, inputSchema: { type: "object" } },
      { provider: "custom", name: "b", inputSchema: { type: "object" } },
    ],
  };
  const { body } = toWire(toolsOnly, "m", { oauth: false, autoCache: true });
  expect(body.tools?.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
  expect(body.tools?.[0]?.cache_control).toBeUndefined();
});

test("the breakpoint goes on the wire body and never back onto the request", () => {
  // `dispatchRequest` is one shared object across every attempt, so a marker
  // written onto the IR would follow a failover into another provider and into
  // what RTK and the token estimate believe the client sent.
  const request: ChatRequest = structuredClone(UNMARKED);
  const before = JSON.stringify(request);
  toWire(request, "m", { oauth: false, autoCache: true });
  expect(JSON.stringify(request)).toBe(before);
  // And a second encode of the same IR still sees an unmarked request.
  const second = toWire(request, "m", { oauth: false, autoCache: true });
  expect(second.degradations).toContain("anthropic:cache-breakpoint-added");
});

test("marks the client's own last system block, not the oauth prefix", () => {
  const { body } = toWire(UNMARKED, "m", { oauth: true, autoCache: true });
  expect(body.system?.[0]?.text).toBe(OAUTH_IDENTITY);
  expect(body.system?.[0]?.cache_control).toBeUndefined();
  // Last block, so the breakpoint covers the injected prefix and the client's
  // own system prompt together.
  expect(body.system?.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
});

test("the adapter honours the operator's auto-cache flag end to end", async () => {
  // The unit tests above drive `toWire` directly, so none of them notices if
  // the adapter stops passing the flag through. This is the only assertion
  // standing between the setting and a feature that silently does nothing.
  const on = await capture({ request: UNMARKED, autoCache: true });
  expect(on.body).toContain("cache_control");

  const off = await capture({ request: UNMARKED });
  expect(off.body).not.toContain("cache_control");
});

test("a marker anywhere counts, including inside message history", () => {
  // The third shape of "anywhere", and the one an ordinary client hits: a
  // breakpoint on the last tool result rather than on system or tools.
  const marked: ChatRequest = {
    ...UNMARKED,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi", cacheControl: { type: "ephemeral" } }],
      },
    ],
  };
  const on = toWire(marked, "m", { oauth: false, autoCache: true });
  const off = toWire(marked, "m", { oauth: false });
  expect(JSON.stringify(on.body)).toBe(JSON.stringify(off.body));
  expect(on.degradations).not.toContain("anthropic:cache-breakpoint-added");
});

test("a top-level marker in the vendor bag counts too", () => {
  // Request-level auto-caching never reaches the IR — ingress forwards it
  // through `vendor` — so the estimate cannot see it and the body would end up
  // with two breakpoints, one of which the client never asked for.
  const marked: ChatRequest = {
    ...UNMARKED,
    vendor: { anthropic: { cache_control: { type: "ephemeral" } } },
  };
  const { body, degradations } = toWire(marked, "m", { oauth: false, autoCache: true });
  expect((JSON.stringify(body).match(/cache_control/g) ?? []).length).toBe(1);
  expect(degradations).not.toContain("anthropic:cache-breakpoint-added");
});

test("the size gate measures the prefix it caches, not the whole request", () => {
  // A long conversation under a two-line system prompt: an ordinary agent
  // session. Counting the messages would wave this through and mark a prefix
  // far too small for Anthropic to cache.
  const longChat: ChatRequest = {
    ...base,
    system: [{ type: "text", text: "be terse" }],
    messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(200_000) }] }],
  };
  const { body, degradations } = toWire(longChat, "m", { oauth: false, autoCache: true });
  expect(JSON.stringify(body)).not.toContain("cache_control");
  expect(degradations).not.toContain("anthropic:cache-breakpoint-added");
});

test("a system prompt of only non-text blocks falls through to the tools", () => {
  const odd: ChatRequest = {
    ...base,
    system: [{ type: "image", mediaType: "image/png", data: "aGk=" }],
    tools: [
      { provider: "custom", name: "a", description: BIG_SYSTEM, inputSchema: { type: "object" } },
    ],
  };
  const { body } = toWire(odd, "m", { oauth: false, autoCache: true });
  // `toWire` drops non-text system blocks entirely, so there is no system array
  // left to mark and the last tool takes it.
  expect(body.system).toBeUndefined();
  expect(body.tools?.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
});
