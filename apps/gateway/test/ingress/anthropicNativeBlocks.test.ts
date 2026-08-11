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
