import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";

const minimal = {
  model: "claude-opus-4",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
};

function reason(body: unknown): string {
  try {
    parseAnthropicRequest(body);
    return "";
  } catch (e) {
    if (!(e instanceof GatewayError)) throw e;
    expect(e.code).toBe("BAD_REQUEST");
    return e.message;
  }
}

test("replayed server tool use and its result survive ingress intact", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "user", content: "search" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "web_search",
            input: { query: "bun" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [
              {
                type: "web_search_result",
                url: "https://example.test",
                title: "t",
                encrypted_content: "OPAQUE",
                page_age: "1d",
              },
            ],
          },
        ],
      },
    ],
  });
  expect(req.messages[1]?.content).toEqual([
    { type: "text", text: "looking" },
    {
      type: "anthropicNative",
      blockType: "server_tool_use",
      data: { id: "srvtoolu_1", name: "web_search", input: { query: "bun" } },
    },
    {
      type: "anthropicNative",
      blockType: "web_search_tool_result",
      data: {
        tool_use_id: "srvtoolu_1",
        content: [
          {
            type: "web_search_result",
            url: "https://example.test",
            title: "t",
            encrypted_content: "OPAQUE",
            page_age: "1d",
          },
        ],
      },
    },
  ]);
});

test("a server tool error result is carried, not rejected", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
          },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "anthropicNative",
    blockType: "web_search_tool_result",
    data: {
      tool_use_id: "srvtoolu_1",
      content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
    },
  });
});

test("text citations survive request-history replay", () => {
  const citation = {
    type: "char_location",
    cited_text: "source",
    document_index: 0,
    document_title: "doc",
    start_char_index: 1,
    end_char_index: 7,
  };
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "answer", citations: [citation] }],
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "text",
    text: "answer",
    citations: [citation],
  });
});

test("redacted thinking survives instead of being flattened to empty text", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "assistant", content: [{ type: "redacted_thinking", data: "EncryptedBlob" }] },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "anthropicNative",
    blockType: "redacted_thinking",
    data: { data: "EncryptedBlob" },
  });
});

test("current request-history native block types survive ingress", () => {
  const blocks = [
    {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "doc" },
      title: "title",
    },
    { type: "mid_conv_system", content: [{ type: "text", text: "instruction" }] },
    { type: "tool_addition", tool: { type: "tool_reference", tool_name: "lookup" } },
    { type: "tool_removal", tool: { type: "tool_reference", tool_name: "lookup" } },
    { type: "fallback", to: { model: "claude-sonnet-5" }, trigger: null },
  ];
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [{ role: "assistant", content: blocks }],
  });
  expect(
    req.messages[0]?.content.map((content) =>
      content.type === "anthropicNative" ? content.blockType : content.type,
    ),
  ).toEqual(blocks.map((block) => block.type));
});

test("response-only native blocks stay illegal in request history", () => {
  const message = reason({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [{ type: "advisor_result", text: "answer" }],
      },
    ],
  });
  expect(message).toContain("messages.0.content.0.type");
  expect(message).toContain("not legal in request history");
});

test("a native block keeps its cache breakpoint as a canonical field", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "search_result",
            source: "s",
            title: "t",
            content: [{ type: "text", text: "x" }],
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "anthropicNative",
    blockType: "search_result",
    data: { source: "s", title: "t", content: [{ type: "text", text: "x" }] },
    cacheControl: { type: "ephemeral", ttl: "1h" },
  });
});

test("an unknown block type is refused with its path", () => {
  const message = reason({
    ...minimal,
    messages: [{ role: "assistant", content: [{ type: "quantum_result", x: 1 }] }],
  });
  expect(message).toContain("messages.0.content.0");
  expect(message).toContain("quantum_result");
});

test("native blocks validate required top-level fields at precise paths", () => {
  for (const [block, field] of [
    [{ type: "server_tool_use", name: "web_search", input: {} }, "id"],
    [{ type: "web_search_tool_result", content: [] }, "tool_use_id"],
    [{ type: "document" }, "source"],
    [{ type: "mid_conv_system" }, "content"],
    [{ type: "tool_addition" }, "tool"],
    [{ type: "fallback" }, "to"],
  ] as const) {
    expect(reason({ ...minimal, messages: [{ role: "assistant", content: [block] }] })).toContain(
      `messages.0.content.0.${field}`,
    );
  }
});

test("native blocks reject malformed cache control instead of discarding it", () => {
  const message = reason({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "web_search",
            input: {},
            cache_control: { type: "forever" },
          },
        ],
      },
    ],
  });
  expect(message).toContain("messages.0.content.0.cache_control.type");
});

test("native block validation preserves nested provider payloads", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [{ type: "future_nested_result", opaque: { x: 1 } }],
            caller: { type: "code_execution_20260521", tool_id: "srvtoolu_2" },
          },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toMatchObject({
    type: "anthropicNative",
    data: {
      content: [{ type: "future_nested_result", opaque: { x: 1 } }],
      caller: { type: "code_execution_20260521", tool_id: "srvtoolu_2" },
    },
  });
});

test("a malformed native block is refused with its path", () => {
  expect(reason({ ...minimal, messages: [{ role: "user", content: [42] }] })).toContain(
    "messages.0.content.0",
  );
});

test("a portable tool result is still flattened and correlated", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "get", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "one" }] },
        ],
      },
    ],
  });
  expect(req.messages[1]?.content[0]).toMatchObject({ type: "toolResult", content: "one" });
});
