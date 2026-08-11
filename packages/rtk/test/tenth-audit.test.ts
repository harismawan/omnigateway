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

function treeRows(): string[] {
  const lines = ["project"];
  for (let directory = 0; directory < 42; directory++) {
    const connector = directory === 41 ? "└── " : "├── ";
    lines.push(`${connector}dir-${directory}/`);
    lines.push(`│   └── child-${directory}.ts`);
  }
  lines.push("42 directories, 42 files");
  return lines;
}

describe("tenth audit regressions", () => {
  test("tree never retains a child without its directory ancestor", () => {
    const fixture = run("tree -F", treeRows());
    expect(fixture.output.report.filters).toContain("tree-output");
    for (let directory = 0; directory < 42; directory++) {
      const child = `child-${directory}.ts`;
      if (fixture.content.includes(child)) {
        const ancestor = `${directory === 41 ? "└── " : "├── "}dir-${directory}/`;
        expect(fixture.content).toContain(ancestor);
        expect(fixture.content.indexOf(ancestor)).toBeLessThan(fixture.content.indexOf(child));
      }
    }
  });

  test("listing group marker stays between complete group fragments", () => {
    const lines: string[] = [];
    for (let group = 0; group < 42; group++) {
      lines.push(`./dir-${group}:`);
      for (let entry = 0; entry < 15; entry++) lines.push(`file-${group}-${entry}.ts`);
    }
    const content = run("ls -R .", lines).content;
    const marker = content.indexOf("directories omitted containing");
    expect(marker).toBeGreaterThan(content.indexOf("./dir-19:"));
    expect(marker).toBeLessThan(content.indexOf("./dir-22:"));
  });

  test("grep range markers stay between complete file fragments", () => {
    const lines: string[] = [];
    for (let file = 0; file < 42; file++)
      for (let match = 0; match < 15; match++)
        lines.push(`src/file-${file}.ts:${match + 1}:${"detail-".repeat(3)}${file}-${match}`);
    const content = run("rg -n pattern src", lines).content;
    const marker = content.indexOf("files omitted containing");
    expect(marker).toBeGreaterThan(content.indexOf("src/file-19.ts:15:"));
    expect(marker).toBeLessThan(content.indexOf("src/file-22.ts:1:"));
  });

  test("grep exceptions retain input order and split omitted ranges", () => {
    const lines: string[] = [];
    for (let file = 0; file < 44; file++) {
      const count = file === 21 ? 1 : 2;
      for (let match = 0; match < count; match++)
        lines.push(
          `src/file-${file}.ts:${match + 1}:${"matched-detail-".repeat(2)}${file}-${match}`,
        );
    }
    const content = run("rg -n pattern src", lines).content;
    expect(content.indexOf("src/file-19.ts:1:")).toBeLessThan(content.indexOf("src/file-21.ts:1:"));
    expect(content.indexOf("src/file-21.ts:1:")).toBeLessThan(content.indexOf("src/file-24.ts:1:"));
    expect(content).not.toContain("src/file-20.ts:1:");
    expect(content).not.toContain("src/file-22.ts:1:");
    expect(content.match(/files? omitted containing/g)?.length).toBe(2);
  });

  test("package warning marker precedes final manager summary", () => {
    const lines = Array.from(
      { length: 25 },
      (_, index) => `npm warn warning-${index}-${"diagnostic-detail-".repeat(2)}`,
    );
    lines.push("added 25 packages in 2s");
    const content = run("npm install", lines).content;
    expect(content).toContain("... 5 warnings omitted ...");
    expect(content.endsWith("added 25 packages in 2s")).toBe(true);
  });
});
