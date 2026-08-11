import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { classifyCommand } from "../src/command.ts";
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

describe("third audit regressions", () => {
  test("global row bound protects generic filtering", () => {
    const fixture = run(
      "echo x",
      Array.from({ length: 100_001 }, () => "x"),
    );
    expect(fixture.output.request).toBe(fixture.input);
  });

  test("tree groups entries by their resolved sibling parent", () => {
    const src = Array.from({ length: 20 }, (_, index) => `│   ├── src-${index}.ts`);
    const tests = Array.from({ length: 20 }, (_, index) => `    ├── test-${index}.ts`);
    const fixture = run("tree -F", [
      "project",
      "├── src/",
      ...src,
      "└── test/",
      ...tests,
      "2 directories, 40 files",
    ]);
    expect(fixture.output.report.filters).toContain("tree-output");
    expect(fixture.content).toContain("... 8 entries omitted from project/src ...");
    expect(fixture.content).toContain("... 8 entries omitted from project/test ...");
    for (const anchor of ["src-0.ts", "src-19.ts", "test-0.ts", "test-19.ts"])
      expect(fixture.content).toContain(anchor);
  });

  test("package warning duplicates count once and emit no omission marker", () => {
    const warning = ["warning: peer conflict package-a@1", "  required by package-b@2"];
    const fixture = run("bun install", [
      "bun install v1.4.0",
      ...Array.from({ length: 25 }, () => warning).flat(),
      ...Array.from({ length: 100 }, (_, index) => `Resolving package ${index}`),
      "installed 1 package",
    ]);
    expect(fixture.output.report.filters).toContain("package-output");
    expect(fixture.content.match(/required by package-b/g)).toHaveLength(1);
    expect(fixture.content).not.toContain("warnings omitted");
  });

  test("piped numbered commands remain wholly ineligible", () => {
    const fixture = run(
      "sed -n '1,300p' file.ts | cat",
      Array.from({ length: 300 }, (_, index) => `${index + 1} | source line`),
    );
    expect(fixture.output.request).toBe(fixture.input);
    expect(fixture.output.report.filters).toEqual([]);
  });

  test("empty quoted wrapper executables are rejected", () => {
    for (const command of ["npx '' eslint src", "bun x '' biome check .", "bun run ''"])
      expect(classifyCommand(command)).toBeUndefined();
  });
});
