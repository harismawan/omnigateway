import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { transformRequest } from "../src/index.ts";

function run(command: string, lines: readonly string[], name = "bash") {
  const input: ChatRequest = {
    model: "fast",
    stream: false,
    messages: [
      { role: "assistant", content: [{ type: "toolUse", id: "x", name, input: { command } }] },
      {
        role: "user",
        content: [{ type: "toolResult", toolUseId: "x", content: lines.join("\n") }],
      },
    ],
  };
  const output = transformRequest(input, { enabled: true });
  const block = output.request.messages[1]?.content[0];
  if (block?.type !== "toolResult") throw new Error("expected tool result");
  return { input, output, content: block.content, original: lines.join("\n") };
}

// Sums every omission marker's stated count so a fixture can prove each omitted row is reported
// exactly once rather than under two competing units.
function omittedTotal(content: string): number {
  let total = 0;
  for (const match of content.matchAll(/^\.\.\. (\d+) [^\n]*omitted[^\n]*\.\.\.$/gm))
    total += Number(match[1] ?? "0");
  return total;
}

describe("seventeenth audit: a classified generic read owns its block, Git shape or not", () => {
  test("cat of a patch file is a numbered read, giving up Git-anchor retention of its middle", () => {
    // What is given up: the middle diff rows. A `git diff` command would keep every `-`/`+` row;
    // read through `cat`, the block is truncated head/tail like any other file. That loss is the
    // deliberate price of never letting output shape override a command classification — three
    // successive attempts to make the shape call showed it cannot be made safely from bytes alone.
    const lines = [
      "diff --git a/src/big.ts b/src/big.ts",
      "index 1111111..2222222 100644",
      "--- a/src/big.ts",
      "+++ b/src/big.ts",
      "@@ -1,400 +1,400 @@",
    ];
    for (let index = 0; index < 400; index++) {
      lines.push(`-const removedCriticalLine${index} = ${index};`);
      if (index % 20 === 19) lines.push("   untouched filler context row");
    }
    const fixture = run("cat patch.diff", lines);
    // Compression must actually have run: an untouched block would satisfy every assertion below.
    expect(fixture.output.report.applied).toBe(true);
    expect(fixture.output.report.filters).toContain("numbered-read");
    expect(fixture.output.report.filters).not.toContain("git-diff");
    expect(fixture.content.length).toBeLessThan(fixture.original.length);
    // 425 rows: a 100-row head and 50-row tail survive, so exactly 275 are omitted and stated once.
    expect(lines.length).toBe(425);
    expect(omittedTotal(fixture.content)).toBe(275);
    expect(fixture.content).toContain("-const removedCriticalLine0 = 0;");
    expect(fixture.content).toContain("-const removedCriticalLine399 = 399;");
  });

  test("the same patch from a git diff command still keeps every changed row", () => {
    // The control for the trade above: when the command names the family, Git retention is intact.
    const lines = [
      "diff --git a/src/big.ts b/src/big.ts",
      "index 1111111..2222222 100644",
      "--- a/src/big.ts",
      "+++ b/src/big.ts",
      "@@ -1,400 +1,400 @@",
    ];
    // The filler is what lets this block shrink at all: every changed row is an anchor, so with too
    // little collapsible bulk the candidate stops being strictly shorter, the acceptance guard
    // rejects it, and the fixture silently stops asserting anything. At one filler row per twenty it
    // carried 20 droppable rows against 405 anchors — 95.3% anchor density and 152 characters of
    // headroom, close enough to the cliff that a later anchor widening would push it over without
    // failing anything. Every assertion below is unchanged; only the collapsible bulk is realistic.
    for (let index = 0; index < 400; index++) {
      lines.push(`-const removedCriticalLine${index} = ${index};`);
      if (index % 5 === 4)
        lines.push(`   untouched filler context row ${index} carrying no marker at all`);
    }
    const fixture = run("git diff", lines);
    expect(fixture.output.report.applied).toBe(true);
    expect(fixture.output.report.filters).toContain("git-diff");
    expect(fixture.content.length).toBeLessThan(fixture.original.length);
    for (let index = 0; index < 400; index++)
      expect(fixture.content).toContain(`-const removedCriticalLine${index} = ${index};`);
  });

  test("cat of prose stays a numbered read and accounts for every omitted row", () => {
    const lines = Array.from(
      { length: 300 },
      (_, index) => `## 1.${index}.0 - release note ${index} describing an operator visible change`,
    );
    const fixture = run("cat CHANGELOG.md", lines);
    expect(fixture.output.report.applied).toBe(true);
    expect(fixture.output.report.filters).toContain("numbered-read");
    expect(fixture.output.report.filters).not.toContain("git-diff");
    expect(fixture.content.length).toBeLessThan(fixture.original.length);
    // A numbered read retains a 100-row head and 50-row tail; the remaining 150 rows must be stated
    // exactly once rather than disappearing silently.
    expect(omittedTotal(fixture.content)).toBe(150);
    expect(fixture.content).toContain(lines[99] ?? "");
    expect(fixture.content).toContain(lines[299] ?? "");
  });
});

describe("seventeenth audit: diagnostics count interleaved omitted warnings once", () => {
  test("non-contiguous omitted warnings are not reported as both lines and warnings", () => {
    const lines = ["a.ts(1,1): error TS1: boom error anchor here padding padding padding"];
    for (let index = 0; index < 25; index++) {
      lines.push(
        `w${index}.ts(${index + 2},2): warning TS6133: 'unused${index}' is declared but never used okay`,
      );
      lines.push(`----- separator row ${index} -----`);
    }
    lines.push("Found 1 error");
    const fixture = run("tsc --noEmit", lines);
    expect(fixture.output.report.applied).toBe(true);
    expect(fixture.output.report.filters).toContain("lint-output");
    expect(fixture.content.length).toBeLessThan(fixture.original.length);
    const retained = fixture.content.split("\n").filter((line) => !line.startsWith("... ")).length;
    // 52 input rows, 22 retained, so exactly 30 rows are omitted and the markers must total 30.
    expect(retained).toBe(22);
    expect(omittedTotal(fixture.content)).toBe(30);
    expect(fixture.content).toContain("... 5 warnings omitted ...");
    // The explicit final summary must remain the last row.
    expect(fixture.content.endsWith("\nFound 1 error")).toBe(true);
  });
});

describe("seventeenth audit: build accounts for rows outside the selected range", () => {
  test("collapsed rows before and after the selected range are stated", () => {
    const lines = [
      "progress 1",
      "progress 2",
      "",
      "bun build v1.4.0 (production bundle for the gateway release channel)",
    ];
    for (let index = 0; index < 5; index++)
      lines.push(`dist/chunk-${index}-with-a-long-descriptive-name.js  ${1024 + index}`);
    for (let index = 0; index < 10; index++)
      lines.push(`Compiling repeated crate-${index}-with-a-long-descriptive-name v1.0.0`);
    for (let index = 5; index < 10; index++)
      lines.push(`dist/chunk-${index}-with-a-long-descriptive-name.js  ${1024 + index}`);
    lines.push("Build completed in 1200ms with 10 emitted artifacts");
    lines.push("progress 98");
    lines.push("");
    const fixture = run("bun build", lines);
    expect(fixture.output.report.applied).toBe(true);
    expect(fixture.output.report.filters).toContain("build-output");
    expect(fixture.content.length).toBeLessThan(fixture.original.length);
    // 3 leading and 2 trailing rows sit outside the selected range; with the 10 collapsed compile
    // rows inside it, every one of the 15 omitted rows must be stated exactly once.
    expect(omittedTotal(fixture.content)).toBe(15);
    expect(fixture.content.startsWith("... 3 lines omitted ...\n")).toBe(true);
    expect(fixture.content.endsWith("\n... 2 lines omitted ...")).toBe(true);
  });
});
