import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { transformRequest } from "../src/index.ts";

function run(command: string, lines: string[], name = "bash") {
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

describe("eighth audit regressions", () => {
  test("plain recursive ls groups newline entries and reports exact omissions", () => {
    const lines: string[] = [];
    for (let group = 0; group < 42; group++) {
      lines.push(`./dir-${group}:`);
      const count = group === 20 ? 3 : group === 21 ? 7 : group === 0 ? 20 : 1;
      for (let entry = 0; entry < count; entry++) lines.push(`file-${group}-${entry}.ts`);
      lines.push("");
    }
    const fixture = run("ls -R .", lines);
    expect(fixture.output.report.filters).toContain("tree-output");
    expect(fixture.content).toContain("... 2 directories omitted containing 10 entries ...");
    expect(fixture.content).toContain("... 8 entries omitted from ./dir-0 ...");
    expect(fixture.content).toContain("./dir-0:");
    expect(fixture.content).toContain("./dir-41:");
  });

  test("plain recursive ls rejects ambiguous or unassignable rows", () => {
    for (const lines of [
      ["orphan.ts", "./a:", "file.ts"],
      ["./a:", "file.ts", "./b:", ""],
      ["./a:", "bad/name.ts"],
    ]) {
      const fixture = run("ls -R .", [...lines, ...Array.from({ length: 30 }, () => "")]);
      expect(fixture.output.request).toBe(fixture.input);
    }
  });

  test("package parser rejects before allocating near-limit warning structures", () => {
    const warnings = Array.from({ length: 40_000 }, (_, index) => [
      `npm warn [${index + 1}/40000] workspace app: W${index} warning ${index}`,
      "npm warn required by package-a",
    ]).flat();
    const fixture = run("npm install", [...warnings, "installed 1 package"]);
    expect(fixture.output.request).toBe(fixture.input);
  });

  test("unknown-origin Windows grep is recognized without colon ambiguity", () => {
    const lines = Array.from(
      { length: 30 },
      (_, index) => `C:\\repo\\src\\file.ts:${index + 1}:matched descriptive text ${index}`,
    );
    const fixture = run("ignored", lines, "mystery");
    expect(fixture.output.report.filters).toContain("grep");
    expect(fixture.content).toContain(lines[0] ?? "");
    expect(fixture.content).toContain(lines.at(-1) ?? "");
    const ambiguous = run(
      "ignored",
      Array.from({ length: 30 }, (_, index) => `key:value:${index}:prose`),
      "mystery",
    );
    expect(ambiguous.output.request).toBe(ambiguous.input);
  });

  test("grep groups by filename and retains a middle single-match file", () => {
    const lines: string[] = [];
    for (let file = 0; file < 42; file++) {
      const count = file === 20 ? 1 : file === 21 ? 5 : file === 0 ? 20 : 2;
      for (let match = 0; match < count; match++)
        lines.push(`src/file-${file}.ts:${match + 1}:match-${file}-${match}`);
    }
    const fixture = run("rg -n pattern src", lines);
    expect(fixture.output.report.filters).toContain("grep");
    expect(fixture.content).toContain("src/file-20.ts:1:match-20-0");
    expect(fixture.content).toContain("... 8 matches omitted from src/file-0.ts ...");
    expect(fixture.content).toContain("... 1 file omitted containing 5 matches ...");
  });
});
