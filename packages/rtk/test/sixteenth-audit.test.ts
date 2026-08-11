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
  return { input, output, content: block.content };
}

// Sums every omission marker's stated count so a fixture can prove each omitted row is reported
// exactly once rather than under two competing units.
function omittedTotal(content: string): number {
  let total = 0;
  for (const match of content.matchAll(/^\.\.\. (\d+) [^\n]*omitted[^\n]*\.\.\.$/gm))
    total += Number(match[1] ?? "0");
  return total;
}

function markerCount(content: string): number {
  return [...content.matchAll(/^\.\.\. \d+ [^\n]*omitted[^\n]*\.\.\.$/gm)].length;
}

describe("sixteenth audit: classification owns the family", () => {
  test("tsc output carrying a Git commit banner keeps every middle diagnostic", () => {
    const lines = [
      "commit 4f3a1c9d2b8e7a6f5c4d3b2a1908f7e6d5c4b3a2",
      "Author: CI Bot <ci@example.com>",
    ];
    for (let index = 0; index < 40; index++)
      lines.push(
        `src/mod${index}.ts(${index + 1},5): error TS2322: Type mismatch in module ${index}.`,
      );
    // Verbatim tsc: with diagnostics in more than one file it always appends ` in N files`. The
    // previous fixture wrote a bare `Found 40 errors.`, a form tsc only emits for a single file, so
    // it exercised the regex rather than the tool and hid that real tsc output never compressed.
    lines.push("Found 40 errors in 12 files.");
    const original = lines.join("\n");
    const fixture = run("tsc --noEmit", lines);
    expect(fixture.output.report.applied).toBe(true);
    expect(fixture.output.report.filters).toContain("lint-output");
    expect(fixture.output.report.filters).not.toContain("git-log");
    expect(fixture.content.length).toBeLessThan(original.length);
    expect(fixture.content).toContain("Found 40 errors in 12 files.");
    // Generic Git-log retention keeps only a 20-row head and 12-row tail, so these middle rows are
    // exactly the ones a hijacked classification loses.
    for (let index = 18; index <= 28; index++)
      expect(fixture.content).toContain(
        `src/mod${index}.ts(${index + 1},5): error TS2322: Type mismatch in module ${index}.`,
      );
  });

  test("bun test output containing a unified diff keeps every middle failure", () => {
    const lines = [
      "bun test v1.4.0",
      "diff --git a/src/config.ts b/src/config.ts",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -1,4 +1,4 @@",
      "-const retries = 1;",
      "+const retries = 2;",
    ];
    // 60 passing rows sit between the failures so `compressTests` has something to collapse; the
    // assertions below are worthless unless the block really shrank.
    for (let index = 0; index < 60; index++)
      lines.push(`(pass) suite ${index} > uninteresting passing test ${index} finished`);
    for (let index = 0; index < 50; index++)
      lines.push(`FAIL test/suite-${index}.test.ts > important failing test ${index}`);
    lines.push("51 fail");
    lines.push("Ran 101 tests across 12 files.");
    const original = lines.join("\n");
    const fixture = run("bun test", lines);
    expect(fixture.output.report.applied).toBe(true);
    expect(fixture.output.report.filters).toContain("test-output");
    expect(fixture.output.report.filters).not.toContain("git-diff");
    expect(fixture.content.length).toBeLessThan(original.length);
    for (let index = 0; index < 50; index++)
      expect(fixture.content).toContain(
        `FAIL test/suite-${index}.test.ts > important failing test ${index}`,
      );
    const retained = fixture.content
      .split("\n")
      .filter((line) => !/^\.\.\. \d+ [^\n]*omitted[^\n]*\.\.\.$/.test(line)).length;
    expect(omittedTotal(fixture.content)).toBe(lines.length - retained);
  });

  test("npm install output containing a patch diff reports package warnings by count", () => {
    const lines = [
      "diff --git a/node_modules/left-pad/index.js b/node_modules/left-pad/index.js",
      "--- a/node_modules/left-pad/index.js",
      "+++ b/node_modules/left-pad/index.js",
      "@@ -1,3 +1,3 @@",
    ];
    for (let index = 0; index < 40; index++)
      lines.push(`npm warn deprecated pkg-${index}@1.0.0: package ${index} is no longer supported`);
    lines.push("added 120 packages, and audited 900 packages in 12s");
    lines.push("found 3 vulnerabilities (1 moderate, 2 high)");
    const fixture = run("npm install", lines);
    expect(fixture.output.report.filters).not.toContain("git-diff");
    expect(fixture.output.report.filters).toContain("package-output");
    expect(fixture.content).toContain("... 20 warnings omitted ...");
  });

  test("cat of a document containing a diff hunk keeps every middle note", () => {
    const lines = [
      "# Release notes",
      "diff --git a/deploy.sh b/deploy.sh",
      "--- a/deploy.sh",
      "+++ b/deploy.sh",
      "@@ -10,6 +10,6 @@",
    ];
    // 300 notes clear the numbered-read compression threshold of 250 rows, so the block really is
    // filtered and the retention assertions below are not checking untouched input.
    for (let index = 0; index < 300; index++)
      lines.push(`IMPORTANT MIDDLE NOTE ${index}: operators must rotate the key.`);
    const original = lines.join("\n");
    const fixture = run("cat docs/RELEASE.md", lines);
    expect(fixture.output.report.applied).toBe(true);
    expect(fixture.content.length).toBeLessThan(original.length);
    // A handful of quoted diff rows must not hand a 300-row document to the Git-diff line filter,
    // which retains only its own anchors; the document stays with its classified generic read.
    expect(fixture.output.report.filters).not.toContain("git-diff");
    expect(fixture.output.report.filters).toContain("numbered-read");
    // The 5 header rows plus notes 0-94 fill the 100-row head and notes 250-299 the 50-row tail, so
    // the 155 dropped middle notes must be stated exactly once rather than vanishing silently.
    expect(fixture.content).toContain("IMPORTANT MIDDLE NOTE 94: operators must rotate the key.");
    expect(fixture.content).not.toContain(
      "IMPORTANT MIDDLE NOTE 95: operators must rotate the key.",
    );
    expect(omittedTotal(fixture.content)).toBe(155);
    expect(markerCount(fixture.content)).toBe(1);
  });
});

describe("sixteenth audit: diagnostic omission markers sit on line boundaries", () => {
  test("an error whose message embeds the summary text survives intact", () => {
    const lines = ["a.ts(1,1): error TS1: Expected message: Found 2 problems in config."];
    for (let index = 0; index < 12; index++)
      lines.push(`w${index}.ts(${index + 2},2): warning TS6133: 'unused${index}' is declared.`);
    lines.push("mid.ts(50,7): error TS2322: middle anchor must survive.");
    for (let index = 12; index < 25; index++)
      lines.push(`w${index}.ts(${index + 2},2): warning TS6133: 'unused${index}' is declared.`);
    lines.push("Found 2 problems");
    const fixture = run("tsc --noEmit", lines);
    expect(fixture.output.report.filters).toContain("lint-output");
    expect(fixture.content).toContain(
      "a.ts(1,1): error TS1: Expected message: Found 2 problems in config.",
    );
    expect(fixture.content).toContain("mid.ts(50,7): error TS2322: middle anchor must survive.");
    expect(fixture.content.endsWith("... 5 warnings omitted ...\nFound 2 problems")).toBe(true);
  });

  test("a decoy summary row does not attract the omission marker to the top", () => {
    const lines = ["Found 2 problems"];
    for (let index = 0; index < 12; index++)
      lines.push(`w${index}.ts(${index + 2},2): warning TS6133: 'unused${index}' is declared.`);
    lines.push("mid.ts(50,7): error TS2322: middle anchor must survive.");
    for (let index = 12; index < 25; index++)
      lines.push(`w${index}.ts(${index + 2},2): warning TS6133: 'unused${index}' is declared.`);
    lines.push("Found 2 problems");
    const fixture = run("tsc --noEmit", lines);
    expect(fixture.output.report.filters).toContain("lint-output");
    expect(fixture.content.startsWith("... 5 warnings omitted ...")).toBe(false);
    expect(fixture.content).toContain("mid.ts(50,7): error TS2322: middle anchor must survive.");
    expect(fixture.content.endsWith("... 5 warnings omitted ...\nFound 2 problems")).toBe(true);
  });
});

describe("sixteenth audit: omitted rows are reported once", () => {
  test("build output counts collapsed compile rows under a single unit", () => {
    const lines = ["bun build v1.4.0 (production bundle for the gateway release channel)"];
    for (let index = 0; index < 5; index++)
      lines.push(`dist/chunk-${index}-with-a-long-descriptive-name.js  ${1024 + index}`);
    for (let index = 0; index < 10; index++)
      lines.push(`Compiling repeated crate-${index}-with-a-long-descriptive-name v1.0.0`);
    for (let index = 5; index < 10; index++)
      lines.push(`dist/chunk-${index}-with-a-long-descriptive-name.js  ${1024 + index}`);
    lines.push("Build completed in 1200ms with 10 emitted artifacts");
    const fixture = run("bun build", lines);
    expect(fixture.output.report.filters).toContain("build-output");
    expect(markerCount(fixture.content)).toBe(1);
    expect(omittedTotal(fixture.content)).toBe(10);
  });
});

describe("sixteenth audit: gated listing grammar rejects prose", () => {
  test("prose rows carrying a slash are not grouped as listing entries", () => {
    const valid: string[] = [];
    for (let directory = 0; directory < 12; directory++)
      for (let file = 0; file < 20; file++)
        valid.push(`docs/section-${directory}/chapter-${file}.md`);
    for (const invalid of [
      "Permission denied for /var/log",
      "warning cannot read /etc/shadow",
      "Operation not permitted on data/private",
    ]) {
      const middled = [...valid.slice(0, 120), invalid, ...valid.slice(120)];
      const fixture = run("find . -type f", middled);
      expect(fixture.output.request).toBe(fixture.input);
      expect(fixture.content).toContain(invalid);
    }
    // Positive control: the same fixture without the invalid row must compress, so the rejections
    // above are proven to come from the grammar rather than from a fixture that never compresses.
    const control = run("find . -type f", valid);
    expect(control.output.request).not.toBe(control.input);
    expect(control.output.report.filters).toContain("path-list");
    expect(control.content.length).toBeLessThan(valid.join("\n").length);
  });
});
