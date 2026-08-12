import { expect, test } from "bun:test";
import type { StreamEvent } from "@omni/ir";
import { decodeAnthropic } from "../src/anthropic/decode.ts";
import type { SseMessage } from "../src/sse.ts";

async function* msgs(...m: SseMessage[]): AsyncGenerator<SseMessage> {
  for (const x of m) yield x;
}

async function run(...m: SseMessage[]): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of decodeAnthropic(msgs(...m))) out.push(e);
  return out;
}

const start: SseMessage = {
  event: "message_start",
  data: JSON.stringify({ message: { id: "m", model: "claude", usage: { input_tokens: 1 } } }),
};
const stop: SseMessage = { event: "message_stop", data: "{}" };

test("decodes server tool use as a native block with streamed input", async () => {
  const events = await run(
    start,
    {
      event: "content_block_start",
      data: JSON.stringify({
        index: 0,
        content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
      }),
    },
    {
      event: "content_block_delta",
      data: JSON.stringify({
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":"bun"}' },
      }),
    },
    { event: "content_block_stop", data: JSON.stringify({ index: 0 }) },
    stop,
  );
  expect(events[1]).toEqual({
    type: "blockStart",
    index: 0,
    block: {
      type: "anthropicNative",
      blockType: "server_tool_use",
      data: { id: "srvtoolu_1", name: "web_search", input: {} },
    },
  });
  expect(events[2]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "anthropicNativeJson", partial: '{"query":"bun"}' },
  });
});

test("a custom tool_use block still streams as a portable toolUse", async () => {
  const events = await run(
    start,
    {
      event: "content_block_start",
      data: JSON.stringify({
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "get", input: {} },
      }),
    },
    {
      event: "content_block_delta",
      data: JSON.stringify({ index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }),
    },
    stop,
  );
  expect(events[1]).toEqual({
    type: "blockStart",
    index: 0,
    block: { type: "toolUse", id: "toolu_1", name: "get" },
  });
  expect(events[2]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "toolJson", partial: "{}" },
  });
});

test("a server tool result arrives complete and keeps its payload", async () => {
  const events = await run(
    start,
    {
      event: "content_block_start",
      data: JSON.stringify({
        index: 1,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [{ type: "web_search_result", url: "u", title: "t" }],
        },
      }),
    },
    { event: "content_block_stop", data: JSON.stringify({ index: 1 }) },
    stop,
  );
  expect(events[1]).toEqual({
    type: "blockStart",
    index: 1,
    block: {
      type: "anthropicNative",
      blockType: "web_search_tool_result",
      data: {
        tool_use_id: "srvtoolu_1",
        content: [{ type: "web_search_result", url: "u", title: "t" }],
      },
    },
  });
});

test("a server tool failure stays a content block, not a transport error", async () => {
  const events = await run(
    start,
    {
      event: "content_block_start",
      data: JSON.stringify({
        index: 0,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
        },
      }),
    },
    { event: "content_block_stop", data: JSON.stringify({ index: 0 }) },
    stop,
  );
  expect(events.some((e) => e.type === "error")).toBe(false);
  expect(events.at(-1)?.type).toBe("end");
});

test("unknown non-null stop reasons fail as non-retryable protocol errors", async () => {
  const events = await run(
    start,
    {
      event: "message_delta",
      data: JSON.stringify({ delta: { stop_reason: "teleport" }, usage: { output_tokens: 3 } }),
    },
    stop,
  );
  expect(events.at(-1)).toMatchObject({
    type: "error",
    code: "UPSTREAM",
    retryable: false,
  });
  const last = events.at(-1);
  expect(last?.type === "error" ? last.message : "").toContain("teleport");
  expect(events.some((event) => event.type === "end")).toBe(false);
});

test("null stop reason remains allowed until a later terminal reason", async () => {
  const events = await run(
    start,
    {
      event: "message_delta",
      data: JSON.stringify({ delta: { stop_reason: null }, usage: { output_tokens: 1 } }),
    },
    stop,
  );
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "endTurn" });
});

test("pause_turn decodes as its own stop reason", async () => {
  const events = await run(
    start,
    {
      event: "message_delta",
      data: JSON.stringify({ delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 3 } }),
    },
    stop,
  );
  const end = events.at(-1);
  expect(end).toMatchObject({ type: "end", stopReason: "pauseTurn" });
});

test("an unrecognized content block type fails visibly", async () => {
  const events = await run(
    start,
    {
      event: "content_block_start",
      data: JSON.stringify({ index: 0, content_block: { type: "quantum_result" } }),
    },
    stop,
  );
  const err = events.find((e) => e.type === "error");
  expect(err).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(err && "message" in err ? err.message : "").toContain("quantum_result");
  // The stream stops there rather than emitting an unmatched block end.
  expect(events.some((e) => e.type === "blockEnd")).toBe(false);
});

test("an unrecognized SSE event type fails visibly", async () => {
  const events = await run(start, { event: "message_teleport", data: "{}" }, stop);
  const err = events.find((e) => e.type === "error");
  expect(err).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(err && "message" in err ? err.message : "").toContain("message_teleport");
});

test("citation and compaction deltas preserve their canonical payloads", async () => {
  const citation = {
    type: "char_location",
    cited_text: "source",
    document_index: 0,
    document_title: "doc",
    start_char_index: 1,
    end_char_index: 7,
  };
  const events = await run(
    start,
    {
      event: "content_block_start",
      data: JSON.stringify({ index: 0, content_block: { type: "text", text: "answer" } }),
    },
    {
      event: "content_block_delta",
      data: JSON.stringify({ index: 0, delta: { type: "citations_delta", citation } }),
    },
    { event: "content_block_stop", data: JSON.stringify({ index: 0 }) },
    {
      event: "content_block_start",
      data: JSON.stringify({ index: 1, content_block: { type: "compaction", content: "" } }),
    },
    {
      event: "content_block_delta",
      data: JSON.stringify({
        index: 1,
        delta: {
          type: "compaction_delta",
          content: "summary",
          encrypted_content: "opaque",
        },
      }),
    },
    { event: "content_block_stop", data: JSON.stringify({ index: 1 }) },
    stop,
  );
  expect(events).toContainEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "anthropicNative", deltaType: "citations_delta", data: { citation } },
  });
  expect(events).toContainEqual({
    type: "blockDelta",
    index: 1,
    delta: {
      type: "anthropicNative",
      deltaType: "compaction_delta",
      data: { content: "summary", encrypted_content: "opaque" },
    },
  });
});

test("an unrecognized block delta type fails visibly", async () => {
  const events = await run(
    start,
    {
      event: "content_block_start",
      data: JSON.stringify({ index: 0, content_block: { type: "text" } }),
    },
    {
      event: "content_block_delta",
      data: JSON.stringify({ index: 0, delta: { type: "hologram_delta", hologram: "x" } }),
    },
    stop,
  );
  const err = events.find((e) => e.type === "error");
  expect(err).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(err && "message" in err ? err.message : "").toContain("hologram_delta");
});

test("ping is still ignored", async () => {
  const events = await run(start, { event: "ping", data: "{}" }, stop);
  expect(events.some((e) => e.type === "error")).toBe(false);
});

test("redacted thinking survives as a native block", async () => {
  const events = await run(
    start,
    {
      event: "content_block_start",
      data: JSON.stringify({
        index: 0,
        content_block: { type: "redacted_thinking", data: "EncryptedBlob" },
      }),
    },
    { event: "content_block_stop", data: JSON.stringify({ index: 0 }) },
    stop,
  );
  expect(events[1]).toEqual({
    type: "blockStart",
    index: 0,
    block: {
      type: "anthropicNative",
      blockType: "redacted_thinking",
      data: { data: "EncryptedBlob" },
    },
  });
});
