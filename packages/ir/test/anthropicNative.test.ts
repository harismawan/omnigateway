import { expect, test } from "bun:test";
import type { AnthropicToolDef, ContentBlock, CustomToolDef } from "../src/request.ts";
import { cacheControlOf } from "../src/request.ts";
import type { StreamEvent, Usage } from "../src/stream.ts";
import { collect } from "../src/stream.ts";
import { estimateInputTokens } from "../src/tokens.ts";
import { validateRequest } from "../src/validate.ts";

const usage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const custom: CustomToolDef = {
  provider: "custom",
  name: "get_weather",
  inputSchema: { type: "object" },
};

const webSearch: AnthropicToolDef = {
  provider: "anthropic",
  family: "webSearch",
  type: "web_search_20250305",
  name: "web_search",
  wire: { max_uses: 5 },
};

test("an Anthropic-native block carries its wire type and payload verbatim", () => {
  const block: ContentBlock = {
    type: "anthropicNative",
    blockType: "web_search_tool_result",
    data: { tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "u" }] },
  };
  expect(cacheControlOf(block)).toBeUndefined();
  expect(cacheControlOf({ ...block, cacheControl: { type: "ephemeral" } })).toEqual({
    type: "ephemeral",
  });
});

test("collect assembles a native block start and its json deltas", () => {
  const events: StreamEvent[] = [
    { type: "start", id: "m", model: "x" },
    {
      type: "blockStart",
      index: 0,
      block: {
        type: "anthropicNative",
        blockType: "server_tool_use",
        data: { id: "srvtoolu_1", name: "web_search", input: {} },
      },
    },
    { type: "blockDelta", index: 0, delta: { type: "anthropicNativeJson", partial: '{"query":' } },
    { type: "blockDelta", index: 0, delta: { type: "anthropicNativeJson", partial: '"bun"}' } },
    { type: "blockEnd", index: 0 },
    { type: "end", stopReason: "pauseTurn", usage: usage() },
  ];
  const r = collect(events);
  expect(r.content).toEqual([
    {
      type: "anthropicNative",
      blockType: "server_tool_use",
      data: { id: "srvtoolu_1", name: "web_search", input: { query: "bun" } },
    },
  ]);
  expect(r.stopReason).toBe("pauseTurn");
});

test("collect keeps a native result block that carries no deltas", () => {
  const r = collect([
    { type: "start", id: "m", model: "x" },
    {
      type: "blockStart",
      index: 0,
      block: {
        type: "anthropicNative",
        blockType: "web_search_tool_result",
        data: { tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "u" }] },
      },
    },
    { type: "blockEnd", index: 0 },
    { type: "end", stopReason: "endTurn", usage: usage() },
  ]);
  expect(r.content).toEqual([
    {
      type: "anthropicNative",
      blockType: "web_search_tool_result",
      data: { tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "u" }] },
    },
  ]);
});

test("native blocks survive validation without joining tool-id correlation", () => {
  const cleaned = validateRequest({
    model: "m",
    stream: false,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "anthropicNative",
            blockType: "server_tool_use",
            data: { id: "srvtoolu_1", name: "web_search", input: {} },
          },
          {
            type: "anthropicNative",
            blockType: "web_search_tool_result",
            data: { tool_use_id: "srvtoolu_1", content: [] },
          },
          // An orphan custom result is still removed; the native pair above did
          // not register `srvtoolu_1` as a custom tool use.
          { type: "toolResult", toolUseId: "srvtoolu_1", content: "x" },
        ],
      },
    ],
  });
  expect(cleaned.messages[0]?.content.map((b) => b.type)).toEqual([
    "anthropicNative",
    "anthropicNative",
  ]);
});

test("token estimation counts both tool variants", () => {
  const withCustom = estimateInputTokens({
    model: "m",
    stream: false,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [custom],
  });
  const withBoth = estimateInputTokens({
    model: "m",
    stream: false,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [custom, webSearch],
  });
  expect(withBoth).toBeGreaterThan(withCustom);
});

test("token estimation counts a native block's payload", () => {
  const base = estimateInputTokens({
    model: "m",
    stream: false,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });
  const withNative = estimateInputTokens({
    model: "m",
    stream: false,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          {
            type: "anthropicNative",
            blockType: "web_search_tool_result",
            data: { content: [{ type: "web_search_result", url: "u".repeat(400) }] },
          },
        ],
      },
    ],
  });
  expect(withNative).toBeGreaterThan(base + 80);
});
