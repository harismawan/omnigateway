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

describe("ninth audit regressions", () => {
  test("retained middle exception is excluded from omitted grep totals", () => {
    const lines: string[] = [];
    for (let file = 0; file < 42; file++) {
      const count = file === 20 ? 1 : file === 21 ? 5 : 2;
      for (let match = 0; match < count; match++)
        lines.push(`src/file-${file}.ts:${match + 1}:match-${file}-${match}`);
    }
    const fixture = run("rg -n pattern src", lines);
    expect(fixture.content).toContain("src/file-20.ts:1:match-20-0");
    expect(fixture.content).toContain("... 1 file omitted containing 5 matches ...");
    expect(fixture.content).not.toContain("2 files omitted");
  });

  test("context separator survives between adjacent retained regions", () => {
    const fixture = run("rg -n -C 1 pattern src", [
      "src/a.ts:1:first",
      "src/a.ts-2-context",
      "--",
      "src/a.ts-20-context",
      "src/a.ts:21:second",
      ...Array.from({ length: 30 }, (_, index) => `src/a.ts-${22 + index}-long-context-tail`),
    ]);
    expect(fixture.output.report.filters).toContain("grep");
    expect(fixture.content).toContain("--");
    for (const line of [
      "src/a.ts:1:first",
      "src/a.ts-2-context",
      "src/a.ts-20-context",
      "src/a.ts:21:second",
    ])
      expect(fixture.content).toContain(line);
  });

  test("ambiguous context separator assignment retains original", () => {
    const fixture = run("rg -n -C 1 pattern src", [
      "src/a.ts:1:first",
      "--",
      "src/b.ts-2-context",
      ...Array.from({ length: 20 }, (_, index) => `src/b.ts-${3 + index}-tail`),
    ]);
    expect(fixture.output.request).toBe(fixture.input);
  });

  test("grep match quota excludes heading and context rows", () => {
    const lines = ["src/a.ts"];
    for (let match = 0; match < 13; match++) {
      const text = match === 6 ? `match-${match}-${"detail-".repeat(12)}` : `match-${match}`;
      lines.push(`${match * 3 + 1}:${text}`);
      lines.push(`${match * 3 + 2}-context-a`, `${match * 3 + 3}-context-b`);
    }
    const fixture = run("rg --heading -n -C 2 pattern src", lines);
    expect(fixture.content).toContain("src/a.ts");
    expect(fixture.content).toContain("... 1 match omitted from src/a.ts ...");
    expect(fixture.content).not.toContain("entries omitted");
  });

  test("listing entry quota excludes heading and total structures", () => {
    const rows = Array.from(
      { length: 13 },
      (_, index) => `-rw-r--r-- 1 u g 10 Aug 10 12:00 file-${index}.ts`,
    );
    const fixture = run("ls -lR .", ["./src:", "total 13", ...rows]);
    expect(fixture.content).toContain("./src:");
    expect(fixture.content).toContain("total 13");
    expect(fixture.content).toContain("... 1 entry omitted from ./src ...");
  });
});
