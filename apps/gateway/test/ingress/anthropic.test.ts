import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";

const minimal = {
  model: "claude-opus-4",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
};

test("parses a minimal request and defaults stream to false", () => {
  const req = parseAnthropicRequest(minimal);
  expect(req.model).toBe("claude-opus-4");
  expect(req.maxTokens).toBe(1024);
  expect(req.stream).toBe(false);
  expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("normalises a string system prompt to blocks", () => {
  expect(parseAnthropicRequest({ ...minimal, system: "be terse" }).system).toEqual([
    { type: "text", text: "be terse" },
  ]);
});

test("accepts a block-array system prompt", () => {
  expect(
    parseAnthropicRequest({ ...minimal, system: [{ type: "text", text: "a" }] }).system,
  ).toEqual([{ type: "text", text: "a" }]);
});

test("parses image blocks", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "image",
    mediaType: "image/png",
    data: "AAAA",
  });
});

test("parses tool use and tool result blocks", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "f", input: { a: 1 } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "toolUse",
    id: "tu_1",
    name: "f",
    input: { a: 1 },
  });
  expect(req.messages[1]?.content[0]).toEqual({
    type: "toolResult",
    toolUseId: "tu_1",
    content: "ok",
    isError: false,
  });
});

test("stringifies structured tool result content", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "f", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "one" }] },
        ],
      },
    ],
  });
  expect(req.messages[1]?.content[0]).toMatchObject({ type: "toolResult", content: "one" });
});

test("stringifies non-text tool result parts without throwing", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "f", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t", content: [42, null, { foo: "bar" }] }],
      },
    ],
  });
  const result = req.messages[1]?.content[0];
  expect(result).toMatchObject({ type: "toolResult" });
  if (result?.type === "toolResult") {
    expect(result.content).toBe(["42", "null", '{"foo":"bar"}'].join("\n"));
  }
});

test("parses tools and tool choice", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "f" },
  });
  expect(req.tools).toEqual([{ name: "f", description: "d", inputSchema: { type: "object" } }]);
  expect(req.toolChoice).toEqual({ type: "tool", name: "f" });
});

test("rejects a non-object tool input_schema", () => {
  expect(() =>
    parseAnthropicRequest({
      ...minimal,
      tools: [{ name: "f", input_schema: "not-an-object" }],
    }),
  ).toThrow(GatewayError);
});

test("maps a thinking block onto the reasoning config", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    thinking: { type: "enabled", budget_tokens: 8000 },
  });
  // A budget the client named is carried verbatim, not reinterpreted as an
  // effort level — providers reject a synthesized one.
  expect(req.reasoning).toEqual({ mode: "budget", budgetTokens: 8000 });
});

test("accepts adaptive thinking, the current wire shape", () => {
  const req = parseAnthropicRequest({ ...minimal, thinking: { type: "adaptive" } });
  expect(req.reasoning).toEqual({ mode: "adaptive" });
});

test("carries the thinking display preference", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    thinking: { type: "adaptive", display: "summarized" },
  });
  expect(req.reasoning).toEqual({ mode: "adaptive", display: "summarized" });
});

test("reads effort out of output_config so it survives cross-provider routing", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    thinking: { type: "adaptive" },
    output_config: { effort: "xhigh" },
  });
  expect(req.reasoning).toEqual({ mode: "adaptive", effort: "xhigh" });
  // The field itself is left intact for Anthropic, alongside anything else in
  // it that this gateway does not model.
  expect(req.vendor?.anthropic?.output_config).toEqual({ effort: "xhigh" });
});

test("effort alone implies adaptive thinking", () => {
  const req = parseAnthropicRequest({ ...minimal, output_config: { effort: "high" } });
  expect(req.reasoning).toEqual({ mode: "adaptive", effort: "high" });
});

test("ignores an effort level it does not recognise", () => {
  const req = parseAnthropicRequest({ ...minimal, output_config: { effort: "turbo" } });
  expect(req.reasoning).toBeUndefined();
});

test("keeps an explicit opt-out rather than dropping it", () => {
  const req = parseAnthropicRequest({ ...minimal, thinking: { type: "disabled" } });
  expect(req.reasoning).toEqual({ mode: "off" });
});

test("passes unknown top-level fields through as vendor extras", () => {
  expect(parseAnthropicRequest({ ...minimal, top_k: 40 }).vendor?.anthropic).toEqual({ top_k: 40 });
});

test("applies IR validation to the parsed request", () => {
  // An orphaned tool result is dropped by validateRequest, leaving an empty
  // message that is then removed.
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "nope", content: "x" }] },
    ],
  });
  expect(req.messages).toHaveLength(1);
});

test("rejects a request with no messages", () => {
  expect(() => parseAnthropicRequest({ ...minimal, messages: [] })).toThrow(GatewayError);
});

test("rejects a missing model with a field path in the message", () => {
  try {
    parseAnthropicRequest({ max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    throw new Error("expected throw");
  } catch (e) {
    expect((e as GatewayError).code).toBe("BAD_REQUEST");
    expect((e as GatewayError).message).toContain("model");
  }
});

test("carries a mid-conversation system message through in place", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    system: "You are a helpful assistant.",
    messages: [
      { role: "user", content: "hi" },
      { role: "system", content: "Terse mode enabled — keep responses under 40 words." },
    ],
  });

  // The request-level prompt and the mid-conversation turn are different
  // things: folding the turn into the prompt would move it to the front of the
  // conversation and change when it applies.
  expect(req.system).toEqual([{ type: "text", text: "You are a helpful assistant." }]);
  expect(req.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "system",
      content: [{ type: "text", text: "Terse mode enabled — keep responses under 40 words." }],
    },
  ]);
});

test("accepts block content on a system turn", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "user", content: "hi" },
      { role: "system", content: [{ type: "text", text: "Use Go." }] },
    ],
  });

  expect(req.messages.at(-1)).toEqual({
    role: "system",
    content: [{ type: "text", text: "Use Go." }],
  });
});

test("keeps a system turn in position rather than reordering the conversation", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "user", content: "first" },
      { role: "system", content: "mid-flight instruction" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ],
  });

  expect(req.messages.map((m) => m.role)).toEqual(["user", "system", "assistant", "user"]);
});

test("still rejects a role no surface defines", () => {
  expect(() =>
    parseAnthropicRequest({
      ...minimal,
      messages: [{ role: "developer", content: "hi" }],
    }),
  ).toThrow(GatewayError);
});
