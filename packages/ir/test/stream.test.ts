import { expect, test } from "bun:test";
import type { StreamEvent, Usage } from "../src/stream.ts";
import { collect } from "../src/stream.ts";

const usage = (overrides: Partial<Usage> = {}): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...overrides,
});

test("collect assembles text deltas into one block", () => {
  const events: StreamEvent[] = [
    { type: "start", id: "msg_1", model: "claude-opus-4" },
    { type: "blockStart", index: 0, block: { type: "text" } },
    { type: "blockDelta", index: 0, delta: { type: "text", text: "Hel" } },
    { type: "blockDelta", index: 0, delta: { type: "text", text: "lo" } },
    { type: "blockEnd", index: 0 },
    { type: "end", stopReason: "endTurn", usage: usage({ inputTokens: 10, outputTokens: 2 }) },
  ];
  const r = collect(events);
  expect(r.content).toEqual([{ type: "text", text: "Hello" }]);
  expect(r.stopReason).toBe("endTurn");
  expect(r.usage).toEqual(usage({ inputTokens: 10, outputTokens: 2 }));
  expect(r.id).toBe("msg_1");
  expect(r.model).toBe("claude-opus-4");
});

test("collect assembles tool json deltas into toolUse input", () => {
  const r = collect([
    { type: "start", id: "m", model: "x" },
    { type: "blockStart", index: 0, block: { type: "toolUse", id: "t1", name: "get" } },
    { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"a":' } },
    { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: "1}" } },
    { type: "blockEnd", index: 0 },
    { type: "end", stopReason: "toolUse", usage: usage() },
  ]);
  expect(r.content).toEqual([{ type: "toolUse", id: "t1", name: "get", input: { a: 1 } }]);
});

test("collect preserves thinking text and signature", () => {
  const r = collect([
    { type: "start", id: "m", model: "x" },
    { type: "blockStart", index: 0, block: { type: "thinking" } },
    { type: "blockDelta", index: 0, delta: { type: "thinking", text: "hmm" } },
    { type: "blockDelta", index: 0, delta: { type: "thinkingSignature", signature: "sig123" } },
    { type: "blockEnd", index: 0 },
    { type: "end", stopReason: "endTurn", usage: usage() },
  ]);
  expect(r.content).toEqual([{ type: "thinking", text: "hmm", signature: "sig123" }]);
});

test("collect orders blocks by index, not arrival", () => {
  const r = collect([
    { type: "start", id: "m", model: "x" },
    { type: "blockStart", index: 0, block: { type: "text" } },
    { type: "blockStart", index: 1, block: { type: "text" } },
    { type: "blockDelta", index: 1, delta: { type: "text", text: "second" } },
    { type: "blockDelta", index: 0, delta: { type: "text", text: "first" } },
    { type: "end", stopReason: "endTurn", usage: usage() },
  ]);
  expect(r.content).toEqual([
    { type: "text", text: "first" },
    { type: "text", text: "second" },
  ]);
});

test("collect tolerates truncated tool json", () => {
  const r = collect([
    { type: "start", id: "m", model: "x" },
    { type: "blockStart", index: 0, block: { type: "toolUse", id: "t1", name: "get" } },
    { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: "{not json" } },
    { type: "end", stopReason: "toolUse", usage: usage() },
  ]);
  expect(r.content).toEqual([{ type: "toolUse", id: "t1", name: "get", input: {} }]);
});

test("collect reports zero usage for a stream that never ends", () => {
  const r = collect([
    { type: "start", id: "m", model: "x" },
    { type: "blockStart", index: 0, block: { type: "text" } },
    { type: "blockDelta", index: 0, delta: { type: "text", text: "cut off" } },
  ]);
  // No `end` event means no usage was ever reported. Zero is the honest
  // answer; dispatch prices this at zero rather than guessing.
  expect(r.usage).toEqual(usage());
  expect(r.stopReason).toBe("endTurn");
});
