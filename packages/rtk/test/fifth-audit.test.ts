import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { transformRequest } from "../src/index.ts";

function run(command: string, lines: string[]) {
  const input: ChatRequest = {
    model: "fast",
    stream: false,
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "x", name: "bash", input: { command } }],
      },
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
const noise = Array.from({ length: 100 }, (_, index) => `progress ${index}`);

describe("fifth audit regressions", () => {
  test.each([
    [
      "vitest run",
      [
        " FAIL  test/math.test.ts > adds",
        "AssertionError: expected 1 to be 2",
        "  Expected: 2",
        "  Received: 1",
        "  ❯ test/math.test.ts:10:3",
        "  Attachment: artifacts/failure.png",
        "  Trace: artifacts/trace.zip",
        "Test Files 1 failed",
        "Tests 1 failed",
      ],
    ],
    [
      "jest",
      [
        "  ● math > adds",
        "    expect(received).toBe(expected)",
        "    at test/math.test.ts:10:3",
        "Test Suites: 1 failed",
        "Tests: 1 failed",
      ],
    ],
    [
      "bun test",
      [
        "  FAIL math > adds",
        "error: expected 1",
        "    at test/math.test.ts:10:3",
        "1 fail",
        "Ran 1 test across 1 file",
      ],
    ],
    [
      "pytest",
      [
        "  FAILED test_math.py::test_adds - assert 1 == 2",
        "    test_math.py:10: AssertionError",
        "1 failed in 1.0s",
      ],
    ],
    [
      "go test ./...",
      [
        "    --- FAIL: TestAdds (0.00s)",
        "        math_test.go:10: expected 2",
        "FAIL example/math 1.0s",
      ],
    ],
  ])("preserves complete whitespace-prefixed %s failures", (command, anchors) => {
    const fixture = run(command, ["runner start", ...noise, ...anchors, ...noise]);
    expect(fixture.output.report.filters).toContain("test-output");
    for (const anchor of anchors) expect(fixture.content).toContain(anchor);
  });

  test("directory omission reports omitted group and entry totals", () => {
    const lines = ["root"];
    for (let group = 0; group < 42; group++) {
      lines.push(`${group === 41 ? "└──" : "├──"} dir-${group}/`);
      const count = group === 20 ? 3 : group === 21 ? 7 : 1;
      for (let entry = 0; entry < count; entry++)
        lines.push(`${group === 41 ? "    " : "│   "}├── file-${group}-${entry}.ts`);
    }
    lines.push("42 directories, 50 files");
    const fixture = run("tree -F", lines);
    expect(fixture.content).toContain("... 30 directories omitted containing 38 entries ...");
  });

  test("unsupported repeated test output remains original identity", () => {
    const fixture = run("bun test", [
      "custom reporter v1",
      ...Array.from({ length: 300 }, () => "same unsupported row"),
      "custom end",
    ]);
    expect(fixture.output.request).toBe(fixture.input);
    expect(fixture.output.report.filters).toEqual([]);
  });

  test("package warning identity ignores transient counters and workspace decorations", () => {
    const variants = [
      "npm warn [1/25] workspace app: ERESOLVE peer conflict package-a@1",
      "npm warn [25/25] workspace app: ERESOLVE peer conflict package-a@1",
    ];
    const fixture = run("npm install", [
      "npm install",
      ...noise,
      variants[0] ?? "",
      "npm warn required by package-b@2",
      variants[1] ?? "",
      "npm warn required by package-b@2",
      "installed 1 package",
    ]);
    expect(fixture.output.report.filters).toContain("package-output");
    expect(fixture.content.match(/ERESOLVE peer conflict/g)).toHaveLength(1);
    expect(fixture.content).not.toContain("warnings omitted");
    expect(fixture.content).toContain("[1/25]");
  });
});
