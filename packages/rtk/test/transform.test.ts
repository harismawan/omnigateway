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
    const content = [
      "bun test v1.4.0",
      ...Array.from({ length: 300 }, () => "case passed"),
      "300 pass",
      "0 fail",
      "Ran 300 tests across 10 files",
    ].join("\n");
    const input = request("bash", content);
    const result = transformRequest(input, { enabled: true });
    expect(result.request).not.toBe(input);
    expect(resultContent(result.request).length).toBeLessThan(content.length);
    expect(resultContent(input)).toBe(content);
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

  test("format filters preserve semantic anchors from the middle", () => {
    const padding = Array.from({ length: 100 }, (_, i) => `routine line ${i}`);
    const cases = [
      {
        command: "git diff",
        content: [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          ...padding,
          "@@ -200,2 +200,2 @@",
          "-old middle value",
          "+new middle value",
          ...padding,
          " 1 file changed, 1 insertion(+), 1 deletion(-)",
        ].join("\n"),
        anchors: ["@@ -200,2 +200,2 @@", "+new middle value"],
      },
      {
        command: "bun build src/index.ts",
        content: [
          "bun build v1.4.0",
          "Bundled 100 modules",
          ...Array.from({ length: 100 }, (_, i) => `progress ${i}`),
          "src/middle.ts:42:7 error: cannot assign string to number",
          "    at compile (src/compiler.ts:9:2)",
          ...Array.from({ length: 100 }, (_, i) => `progress ${i + 100}`),
          "Build failed with 1 error",
        ].join("\n"),
        anchors: ["src/middle.ts:42:7 error: cannot assign string to number", "at compile"],
      },
      {
        command: "bun test",
        content: [
          "bun test v1.4.0",
          "10 pass",
          ...padding,
          "FAIL middle behavior preserves data",
          "    at test/middle.test.ts:42:7",
          ...padding,
          "1 fail",
        ].join("\n"),
        anchors: ["FAIL middle behavior preserves data", "at test/middle.test.ts:42:7"],
      },
    ];

    for (const fixture of cases) {
      const input = request("bash", fixture.content);
      const use = input.messages[0]?.content[0];
      if (use?.type === "toolUse") use.input = { command: fixture.command };
      const output = resultContent(transformRequest(input, { enabled: true }).request);
      for (const anchor of fixture.anchors) expect(output).toContain(anchor);
      expect(output.length).toBeLessThan(fixture.content.length);
    }
  });

  test("unknown origin requires multiple build or test anchors", () => {
    const weak = [
      `const message = "error: build failed";\n${"source code\n".repeat(80)}`,
      `${JSON.stringify({ status: "10 pass" })}\n${"json payload\n".repeat(80)}`,
      `The prose says Compiling is useful.\n${"paragraph text\n".repeat(80)}`,
      `ordinary log\nwarning: one transient event\n${"service healthy\n".repeat(80)}`,
    ];
    for (const content of weak) {
      const input = request("mystery", content);
      expect(transformRequest(input, { enabled: true }).request).toBe(input);
    }

    const strong = `bun test v1.4.0\n${"case passed\n".repeat(30)}10 pass\n0 fail\n${"detail line\n".repeat(50)}`;
    expect(
      transformRequest(request("mystery", strong), { enabled: true }).report.filters,
    ).toContain("test-output");
  });

  test("numbered-read requires confirmed shell origin", () => {
    const content = Array.from({ length: 300 }, (_, i) => `${i + 1} | source line`).join("\n");
    const unknown = request("mystery", content);
    expect(transformRequest(unknown, { enabled: true }).request).toBe(unknown);

    const shell = request("bash", content);
    const use = shell.messages[0]?.content[0];
    if (use?.type === "toolUse") use.input = { command: "sed -n '1,300p' file.ts" };
    expect(transformRequest(shell, { enabled: true }).report.filters).toContain("numbered-read");
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
