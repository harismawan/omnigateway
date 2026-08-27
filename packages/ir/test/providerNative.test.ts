import { expect, test } from "bun:test";
import type { AnthropicToolDef, ContentBlock, CustomToolDef, ToolDef } from "../src/request.ts";
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
  kind: "portable",
  name: "get_weather",
  inputSchema: { type: "object" },
};

const webSearch: AnthropicToolDef = {
  kind: "provider",
  provider: "anthropic",
  family: "webSearch",
  type: "web_search_20250305",
  name: "web_search",
  wire: { max_uses: 5 },
};

test("a provider-native block carries its wire type and payload verbatim", () => {
  const block: ContentBlock = {
    type: "providerNative",
    provider: "anthropic",
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
        type: "providerNative",
        provider: "anthropic",
        blockType: "server_tool_use",
        data: { id: "srvtoolu_1", name: "web_search", input: {} },
      },
    },
    {
      type: "blockDelta",
      index: 0,
      delta: { type: "providerNativeJson", provider: "anthropic", partial: '{"query":' },
    },
    {
      type: "blockDelta",
      index: 0,
      delta: { type: "providerNativeJson", provider: "anthropic", partial: '"bun"}' },
    },
    { type: "blockEnd", index: 0 },
    { type: "end", stopReason: "pauseTurn", usage: usage() },
  ];
  const r = collect(events);
  expect(r.content).toEqual([
    {
      type: "providerNative",
      provider: "anthropic",
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
        type: "providerNative",
        provider: "anthropic",
        blockType: "web_search_tool_result",
        data: { tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "u" }] },
      },
    },
    { type: "blockEnd", index: 0 },
    { type: "end", stopReason: "endTurn", usage: usage() },
  ]);
  expect(r.content).toEqual([
    {
      type: "providerNative",
      provider: "anthropic",
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
            type: "providerNative",
            provider: "anthropic",
            blockType: "server_tool_use",
            data: { id: "srvtoolu_1", name: "web_search", input: {} },
          },
          {
            type: "providerNative",
            provider: "anthropic",
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
    "providerNative",
    "providerNative",
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
            type: "providerNative",
            provider: "anthropic",
            blockType: "web_search_tool_result",
            data: { content: [{ type: "web_search_result", url: "u".repeat(400) }] },
          },
        ],
      },
    ],
  });
  expect(withNative).toBeGreaterThan(base + 80);
});

test("a portable tool and a tool the custom provider defines are distinguishable", () => {
  // The portable variant's discriminant used to be `provider: "custom"` — the
  // same string as the `custom` **provider id**, meaning something else
  // entirely. Once the provider-defined variant carries a real `ProviderId`,
  // these two tools collide on that field, and telling them apart is the whole
  // reason the tag moved to `kind`.
  const portable: CustomToolDef = { kind: "portable", name: "shared", inputSchema: {} };
  const byCustomProvider: AnthropicToolDef = {
    kind: "provider",
    provider: "custom",
    family: "webSearch",
    type: "web_search_20250305",
    name: "shared",
    wire: {},
  };
  const tools: ToolDef[] = [portable, byCustomProvider];
  expect(tools.filter((t) => t.kind === "portable")).toEqual([portable]);
  expect(tools.filter((t) => t.kind === "provider")).toEqual([byCustomProvider]);
});

/**
 * The point of `fold`, and the reason it is not just a rename.
 *
 * `collect()` used to switch on `citations_delta` and `compaction_delta` —
 * Anthropic's own wire strings, sitting in `packages/ir`. A second provider
 * wanting either behaviour had to add its spelling to that switch. Now the
 * decoder states the operation and core performs it, so a provider that spells
 * its deltas nothing like Anthropic's gets both for free.
 *
 * These use `kimi` deliberately. Nothing in the repository decodes a kimi native
 * delta today; if this passes, the mechanism is generic rather than Anthropic's
 * behaviour under a new name.
 */
test("any provider's delta can merge into its own native block", () => {
  const events: StreamEvent[] = [
    { type: "start", id: "m", model: "kimi-k2" },
    {
      type: "blockStart",
      index: 0,
      block: { type: "providerNative", provider: "kimi", blockType: "vendor_thing", data: {} },
    },
    {
      type: "blockDelta",
      index: 0,
      delta: {
        type: "providerNative",
        provider: "kimi",
        deltaType: "kimi_specific_name",
        fold: "merge",
        data: { merged: true },
      },
    },
    { type: "end", stopReason: "endTurn", usage: usage() },
  ];

  const [block] = collect(events).content;
  expect(block).toEqual({
    type: "providerNative",
    provider: "kimi",
    blockType: "vendor_thing",
    data: { merged: true },
  });
});

test("any provider's delta can annotate the text block it lands on", () => {
  const citation = { cited_text: "hi", document_index: 0 };
  const events: StreamEvent[] = [
    { type: "start", id: "m", model: "kimi-k2" },
    { type: "blockStart", index: 0, block: { type: "text" } },
    {
      type: "blockDelta",
      index: 0,
      delta: {
        type: "providerNative",
        provider: "kimi",
        deltaType: "kimi_source_ref",
        fold: "citation",
        data: { citation },
      },
    },
    { type: "end", stopReason: "endTurn", usage: usage() },
  ];

  const [block] = collect(events).content;
  expect(block).toEqual({ type: "text", text: "", citations: [citation] });
});

test("a native delta stating no fold is carried, never folded", () => {
  // The default, and what every native delta but those two does. Asserted so
  // that adding a fold kind cannot silently change the meaning of the deltas
  // that state none.
  const events: StreamEvent[] = [
    { type: "start", id: "m", model: "kimi-k2" },
    {
      type: "blockStart",
      index: 0,
      block: { type: "providerNative", provider: "kimi", blockType: "vendor_thing", data: {} },
    },
    {
      type: "blockDelta",
      index: 0,
      delta: {
        type: "providerNative",
        provider: "kimi",
        deltaType: "kimi_specific_name",
        data: { merged: true },
      },
    },
    { type: "end", stopReason: "endTurn", usage: usage() },
  ];

  const [block] = collect(events).content;
  expect(block).toEqual({
    type: "providerNative",
    provider: "kimi",
    blockType: "vendor_thing",
    data: {},
  });
});
