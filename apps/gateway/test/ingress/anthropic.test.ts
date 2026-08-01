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
  expect(req.reasoning).toEqual({ effort: "medium", budgetTokens: 8000 });
});

test("ignores disabled thinking", () => {
  expect(
    parseAnthropicRequest({ ...minimal, thinking: { type: "disabled" } }).reasoning,
  ).toBeUndefined();
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

test("rejects an unknown role", () => {
  expect(() =>
    parseAnthropicRequest({ ...minimal, messages: [{ role: "system", content: "x" }] }),
  ).toThrow(GatewayError);
});
