import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { transformRequest } from "../src/index.ts";

const repeated = Array.from({ length: 600 }, (_, i) =>
  i < 300 ? "same output" : `line ${i}`,
).join("\n");

function request(name: string, content = repeated): ChatRequest {
  return {
    model: "fast",
    stream: false,
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call-1", name, input: { command: "bun test" } }],
      },
      { role: "user", content: [{ type: "toolResult", toolUseId: "call-1", content }] },
    ],
  };
}

function resultContent(value: ChatRequest): string {
  const block = value.messages[1]?.content[0];
  if (block?.type !== "toolResult") throw new Error("expected tool result fixture");
  return block.content;
}

describe("transformRequest", () => {
  test("returns the original request when disabled", () => {
    const input = request("bash");
    const result = transformRequest(input, { enabled: false });
    expect(result.request).toBe(input);
    expect(result.report.applied).toBe(false);
  });

  test("immutably compresses confirmed shell output and reports savings", () => {
    const input = request("bash");
    const result = transformRequest(input, { enabled: true });
    expect(result.request).not.toBe(input);
    expect(resultContent(result.request).length).toBeLessThan(repeated.length);
    expect(resultContent(input)).toBe(repeated);
    expect(result.report.applied).toBe(true);
    expect(result.report.filterHits).toBeGreaterThan(0);
    expect(result.report.estimatedTokensSaved).toBeGreaterThan(0);
  });

  test("excludes known non-shell, errors, and cache-controlled results", () => {
    for (const blockPatch of [
      {},
      { isError: true },
      { cacheControl: { type: "ephemeral" as const } },
    ]) {
      const input = request("read");
      const block = input.messages[1]?.content[0];
      if (block !== undefined) Object.assign(block, blockPatch);
      expect(transformRequest(input, { enabled: true }).request).toBe(input);
    }
  });

  test("unknown origin permits recognizable grep but not generic logs", () => {
    const grep = Array.from({ length: 100 }, (_, i) => `src/file.ts:${i + 1}:matching text`).join(
      "\n",
    );
    expect(transformRequest(request("mystery", grep), { enabled: true }).report.filters).toContain(
      "grep",
    );
    const unknown = request("mystery");
    expect(transformRequest(unknown, { enabled: true }).request).toBe(unknown);
  });

  test("nearest preceding duplicate tool id determines provenance", () => {
    const input = request("bash");
    input.messages.splice(1, 0, {
      role: "assistant",
      content: [{ type: "toolUse", id: "call-1", name: "read", input: { command: "ignored" } }],
    });
    expect(transformRequest(input, { enabled: true }).request).toBe(input);
  });

  test("preserves oversized input and transforms deterministically", () => {
    expect(
      transformRequest(request("bash", "x".repeat(1_000_001)), { enabled: true }).request,
    ).toBeTruthy();
    const input = request("bash");
    expect(transformRequest(input, { enabled: true })).toEqual(
      transformRequest(input, { enabled: true }),
    );
  });
});
