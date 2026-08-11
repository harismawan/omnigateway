import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { classifyCommand } from "../src/command.ts";
import { transformRequest } from "../src/index.ts";

function transform(command: string, lines: string[], name = "bash") {
  const input: ChatRequest = {
    model: "fast",
    stream: false,
    messages: [
      { role: "assistant", content: [{ type: "toolUse", id: "call", name, input: { command } }] },
      {
        role: "user",
        content: [{ type: "toolResult", toolUseId: "call", content: lines.join("\n") }],
      },
    ],
  };
  return { input, output: transformRequest(input, { enabled: true }) };
}

const noise = (count = 300) => Array.from({ length: count }, (_, index) => `progress ${index}`);

function content(request: ChatRequest): string {
  const block = request.messages[1]?.content[0];
  if (block?.type !== "toolResult") throw new Error("expected tool result");
  return block.content;
}

describe("audit regressions", () => {
  test("rejects line breaks, backticks, and substitutions in command text", () => {
    for (const command of [
      "bun test\necho hidden",
      "bun test\r\necho hidden",
      "bun `echo test`",
      "bun $(echo test)",
      'bun "$(echo test)"',
      "bun <(echo test)",
    ])
      expect(classifyCommand(command)).toBeUndefined();
  });

  test("confirmed malformed or structured commands never fall through to output inference", () => {
    const fixture = [
      "bun test v1.4.0",
      ...noise(),
      "FAIL middle",
      "1 fail",
      "Ran 1 test across 1 file",
    ];
    for (const command of ["bun test --json", "bun test | cat", "bun test\necho hidden"]) {
      const { input, output } = transform(command, fixture);
      expect(output.request).toBe(input);
      expect(output.report.filters).toEqual([]);
    }
  });

  test("Docker parser preserves independently placed identity and diagnostic blocks", () => {
    const lines = [
      "#1 [internal] load build definition from Dockerfile",
      ...Array.from({ length: 80 }, () => "#1 1.0 50% transferring"),
      "#7 [builder 3/5] RUN bun build src/index.ts",
      "#7 1.2 Dockerfile:14",
      "#7 1.2 ERROR: process failed",
      "#7 1.2   caused by missing input",
      ...Array.from({ length: 80 }, () => "#7 2.0 75% transferring"),
      "#9 exporting manifest sha256:manifest",
      "#9 exporting provenance sha256:provenance",
      "#9 naming to docker.io/acme/app:latest",
      "#9 DONE image id sha256:image",
    ];
    const result = transform("docker buildx build .", lines).output;
    const rendered = content(result.request);
    expect(result.report.filters).toContain("docker-build");
    for (const anchor of lines.filter((line) =>
      /builder|Dockerfile|ERROR|caused|manifest|provenance|naming|image id/.test(line),
    ))
      expect(rendered).toContain(anchor);
  });

  test("lint parser retains complete unique errors and warning blocks with exact count", () => {
    const errors = [
      "src/a.ts(1,2): error TS1001: first",
      "  source one",
      "  ^ caret one",
      "src/b.ts(2,3): error TS1002: second",
      "  source two",
      "  ^ caret two",
    ];
    const warnings = Array.from({ length: 25 }, (_, index) => [
      `src/w${index}.ts(${index + 1},1): warning TS2000: warning ${index}`,
      `  warning detail ${index}`,
    ]).flat();
    const result = transform("tsc --noEmit", [
      "Version 7",
      ...noise(80),
      ...errors,
      ...noise(80),
      ...warnings,
      "Found 2 errors and 25 warnings.",
    ]).output;
    const rendered = content(result.request);
    for (const line of errors) expect(rendered).toContain(line);
    for (let index = 0; index < 20; index++) expect(rendered).toContain(`warning detail ${index}`);
    expect(rendered).toContain("... 5 warnings omitted ...");
    expect(rendered).toContain("Found 2 errors and 25 warnings.");
  });

  test("test parser retains complete failures independently placed in the middle", () => {
    const failures = [
      "FAIL test/first.test.ts > first behavior",
      "AssertionError: expected 1 to be 2",
      "  Expected: 2",
      "  Received: 1",
      "  at test/first.test.ts:10:3",
      "FAIL test/second.test.ts > second behavior",
      "Error: second failure",
      "  at test/second.test.ts:20:4",
    ];
    const output = transform("bun test", [
      "bun test v1.4.0",
      ...noise(80),
      ...failures,
      ...noise(80),
      "0 pass",
      "2 fail",
      "Ran 2 tests across 2 files",
    ]).output;
    const rendered = content(output.request);
    for (const line of failures) expect(rendered).toContain(line);
    expect(rendered).toContain("Ran 2 tests across 2 files");
  });

  test("build parser retains complete diagnostics, artifacts, and final summary", () => {
    const anchors = [
      "dist/index.js 42 KB",
      "src/index.ts:4:2 error TS2322: mismatch",
      "  source frame",
      "  ^ caret",
      "warning: sourcemap omitted",
      "Build failed with 1 error and 1 warning",
    ];
    const output = transform("bun build src/index.ts", [
      "bun build v1.4.0",
      ...noise(80),
      ...anchors,
      ...noise(80),
    ]).output;
    const rendered = content(output.request);
    for (const line of anchors) expect(rendered).toContain(line);
  });

  test("ambiguous long listing and row-bound overflow retain original identity", () => {
    const ambiguous = transform("ls -la", ["total 100", ...noise(), "locale row cannot parse"]);
    expect(ambiguous.output.request).toBe(ambiguous.input);
    const huge = transform(
      "docker build .",
      Array.from({ length: 100_001 }, () => "#1 1.0 downloading"),
    );
    expect(huge.output.request).toBe(huge.input);
  });
});
