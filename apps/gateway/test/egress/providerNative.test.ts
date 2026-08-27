import { expect, test } from "bun:test";
import type { CollectedResponse, StreamEvent, Usage } from "@omni/ir";
import { collect } from "@omni/ir";
import { anthropicResponse, anthropicStream } from "../../src/egress/anthropic.ts";

const usage: Usage = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

async function* gen(...events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

async function frames(...events: StreamEvent[]): Promise<{ event: string; data: unknown }[]> {
  const out: { event: string; data: unknown }[] = [];
  for await (const f of anthropicStream(gen(...events), "req_1")) {
    out.push({ event: f.event, data: JSON.parse(f.data) as unknown });
  }
  return out;
}

const searchEvents: StreamEvent[] = [
  { type: "start", id: "m", model: "claude-opus-4" },
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
    delta: { type: "providerNativeJson", provider: "anthropic", partial: '{"query":"bun"}' },
  },
  { type: "blockEnd", index: 0 },
  {
    type: "blockStart",
    index: 1,
    block: {
      type: "providerNative",
      provider: "anthropic",
      blockType: "web_search_tool_result",
      data: { tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "u" }] },
    },
  },
  { type: "blockEnd", index: 1 },
  { type: "end", stopReason: "pauseTurn", usage },
];

test("streams native blocks under their own wire types", async () => {
  const out = await frames(...searchEvents);
  expect(out[1]).toEqual({
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
    },
  });
  expect(out[2]).toEqual({
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"query":"bun"}' },
    },
  });
  expect(out[4]).toEqual({
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [{ type: "web_search_result", url: "u" }],
      },
    },
  });
});

test("pause_turn reaches the client as itself", async () => {
  const out = await frames(...searchEvents);
  const delta = out.find((f) => f.event === "message_delta");
  expect(delta?.data).toMatchObject({ delta: { stop_reason: "pause_turn" } });
});

test("non-streaming collection returns the same block structures", () => {
  const collected: CollectedResponse = collect(searchEvents);
  const body = anthropicResponse(collected, "req_1") as {
    content: unknown[];
    stop_reason: string;
  };
  expect(body.content).toEqual([
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "bun" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [{ type: "web_search_result", url: "u" }],
    },
  ]);
  expect(body.stop_reason).toBe("pause_turn");
});

test("citation and compaction deltas survive collection and streaming egress", async () => {
  const citation = {
    type: "char_location",
    cited_text: "source",
    document_index: 0,
    document_title: "doc",
    start_char_index: 1,
    end_char_index: 7,
  };
  const events: StreamEvent[] = [
    { type: "start", id: "m", model: "claude-opus-4" },
    { type: "blockStart", index: 0, block: { type: "text" } },
    {
      type: "blockDelta",
      index: 0,
      delta: {
        type: "providerNative",
        provider: "anthropic",
        deltaType: "citations_delta",
        data: { citation },
      },
    },
    { type: "blockEnd", index: 0 },
    {
      type: "blockStart",
      index: 1,
      block: {
        type: "providerNative",
        provider: "anthropic",
        blockType: "compaction",
        data: { content: "" },
      },
    },
    {
      type: "blockDelta",
      index: 1,
      delta: {
        type: "providerNative",
        provider: "anthropic",
        deltaType: "compaction_delta",
        data: { content: "summary", encrypted_content: "opaque" },
      },
    },
    { type: "blockEnd", index: 1 },
    { type: "end", stopReason: "endTurn", usage },
  ];
  const streamed = await frames(...events);
  expect(streamed).toContainEqual({
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation } },
  });
  expect(streamed).toContainEqual({
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "compaction_delta", content: "summary", encrypted_content: "opaque" },
    },
  });
  const body = anthropicResponse(collect(events), "req_1") as { content: unknown[] };
  expect(body.content).toEqual([
    { type: "text", text: "", citations: [citation] },
    { type: "compaction", content: "summary", encrypted_content: "opaque" },
  ]);
});

test("a suppressed thinking block still renumbers around a native one", async () => {
  const out = await frames(
    { type: "start", id: "m", model: "x" },
    { type: "blockStart", index: 0, block: { type: "thinking", signed: false } },
    {
      type: "blockStart",
      index: 1,
      block: {
        type: "providerNative",
        provider: "anthropic",
        blockType: "server_tool_use",
        data: { id: "s1", name: "web_search", input: {} },
      },
    },
    { type: "blockEnd", index: 1 },
    { type: "end", stopReason: "endTurn", usage },
  );
  const starts = out.filter((f) => f.event === "content_block_start");
  expect(starts).toHaveLength(1);
  expect(starts[0]?.data).toMatchObject({ index: 0 });
});
