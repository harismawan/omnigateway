import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { parseOpenAIRequest } from "../../src/ingress/openai.ts";

const minimal = { model: "gpt-5", messages: [{ role: "user", content: "hi" }] };

test("parses a minimal chat completions request", () => {
  const req = parseOpenAIRequest(minimal);
  expect(req.model).toBe("gpt-5");
  expect(req.stream).toBe(false);
  expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("lifts system and developer messages out of the message list", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      { role: "system", content: "be terse" },
      { role: "developer", content: "and precise" },
      { role: "user", content: "hi" },
    ],
  });
  expect(req.system).toEqual([
    { type: "text", text: "be terse" },
    { type: "text", text: "and precise" },
  ]);
  expect(req.messages).toHaveLength(1);
});

test("parses multi-part content with image urls", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content).toEqual([
    { type: "text", text: "look" },
    { type: "image", mediaType: "image/png", data: "AAAA" },
  ]);
});

test("rejects a non-data image url rather than fetching it", () => {
  expect(() =>
    parseOpenAIRequest({
      ...minimal,
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
        },
      ],
    }),
  ).toThrow(GatewayError);
});

test("parses assistant tool calls and tool result messages", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "toolUse",
    id: "c1",
    name: "f",
    input: { a: 1 },
  });
  expect(req.messages[1]).toEqual({
    role: "user",
    content: [{ type: "toolResult", toolUseId: "c1", content: "ok", isError: false }],
  });
});

test("tolerates malformed tool call arguments", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{oops" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
  });
  expect(req.messages[0]?.content[0]).toMatchObject({ type: "toolUse", input: {} });
});

test("parses tools and the required tool choice", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    tool_choice: "required",
  });
  expect(req.tools).toEqual([{ name: "f", inputSchema: { type: "object" } }]);
  expect(req.toolChoice).toEqual({ type: "any" });
});

test("parses a named tool choice", () => {
  expect(
    parseOpenAIRequest({ ...minimal, tool_choice: { type: "function", function: { name: "f" } } })
      .toolChoice,
  ).toEqual({ type: "tool", name: "f" });
});

test("maps reasoning_effort onto the reasoning config", () => {
  expect(parseOpenAIRequest({ ...minimal, reasoning_effort: "high" }).reasoning).toEqual({
    effort: "high",
  });
});

test("accepts both max_tokens and max_completion_tokens", () => {
  expect(parseOpenAIRequest({ ...minimal, max_tokens: 100 }).maxTokens).toBe(100);
  expect(parseOpenAIRequest({ ...minimal, max_completion_tokens: 200 }).maxTokens).toBe(200);
});

test("normalises a string stop value to an array", () => {
  expect(parseOpenAIRequest({ ...minimal, stop: "END" }).stopSequences).toEqual(["END"]);
});

test("passes unknown fields through as vendor extras", () => {
  expect(parseOpenAIRequest({ ...minimal, top_p: 0.5 }).vendor?.openai).toEqual({ top_p: 0.5 });
});

test("rejects a request with no messages", () => {
  expect(() => parseOpenAIRequest({ ...minimal, messages: [] })).toThrow(GatewayError);
});

test("rejects a request that is only a system message", () => {
  expect(() =>
    parseOpenAIRequest({ ...minimal, messages: [{ role: "system", content: "x" }] }),
  ).toThrow(GatewayError);
});
