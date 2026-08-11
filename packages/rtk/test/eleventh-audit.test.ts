import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { classifyCommand } from "../src/command.ts";
import { compressDiagnostics } from "../src/filters/diagnostics.ts";
import { scanText } from "../src/filters/shared.ts";
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

describe("eleventh audit regressions", () => {
  test("tree selects or omits complete deep subtrees with recursive counts", () => {
    const lines = ["project"];
    for (let directory = 0; directory < 42; directory++) {
      lines.push(`${directory === 41 ? "└──" : "├──"} dir-${directory}/`);
      lines.push("│   └── nested/");
      lines.push(`│       └── leaf-${directory}.ts`);
    }
    lines.push("84 directories, 42 files");
    const content = run("tree -F", lines).content;
    expect(content).toContain("... 60 directories omitted containing 30 entries ...");
    for (let directory = 0; directory < 42; directory++) {
      if (!content.includes(`leaf-${directory}.ts`)) continue;
      expect(content).toContain(`dir-${directory}`);
      expect(content).toContain("nested");
    }
  });

  test("grep preserves exact requested before and after context", () => {
    expect(classifyCommand("rg -n -C 10 pattern src")?.grepMode).toEqual({
      heading: false,
      lineNumber: true,
      beforeContext: 10,
      afterContext: 10,
    });
    const lines = ["src/a.ts:50:first"];
    for (let line = 51; line <= 90; line++) lines.push(`src/a.ts-${line}-context-${line}`);
    lines.push("src/a.ts:91:second");
    for (let line = 92; line <= 130; line++) lines.push(`src/a.ts-${line}-context-${line}`);
    for (let match = 0; match < 11; match++) lines.push(`src/a.ts:${200 + match}:extra-${match}`);
    const content = run("rg -n -C 10 pattern src", lines).content;
    for (let line = 51; line <= 60; line++) expect(content).toContain(`context-${line}`);
    for (let line = 81; line <= 90; line++) expect(content).toContain(`context-${line}`);
  });

  test("long git status preserves known sections and middle paths", () => {
    const middle = Array.from({ length: 40 }, (_, index) => `\tmodified:   src/middle-${index}.ts`);
    const fixture = run("git status", [
      "On branch main",
      "Changes to be committed:",
      '  (use "git restore --staged <file>..." to unstage)',
      "\tnew file:   src/first.ts",
      ...middle,
      "Changes not staged for commit:",
      '  (use "git add <file>..." to update what will be committed)',
      "\tdeleted:    src/deleted.ts",
      "Untracked files:",
      '  (use "git add <file>..." to include in what will be committed)',
      "\tnew-file.ts",
      'no changes added to commit (use "git add" and/or "git commit -a")',
    ]);
    expect(fixture.output.report.filters).toContain("git-status");
    expect(fixture.content).toContain("\tmodified:   src/middle-20.ts");
    expect(fixture.content).toContain("\tdeleted:    src/deleted.ts");
    expect(fixture.content).toContain("\tnew-file.ts");
  });

  test("diagnostics fail open when selecting a later error exceeds budget", () => {
    const text = [
      "lint start",
      "src/a.ts:1:1 error identical error",
      "src/a.ts:1:1 error identical error",
      "  detail one",
      "  detail two",
      "  detail three",
      "Found 2 errors.",
    ].join("\n");
    const input = scanText(text);
    if (input === undefined) throw new Error("expected bounded text");
    expect(input.budget.chargeRecords(99_985)).toBe(true);
    expect(compressDiagnostics(input)).toBe(text);
  });
});
