import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { classifyCommand } from "../src/command.ts";
import { compressListing } from "../src/filters/listings.ts";
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

function broadTree(classified: boolean): string[] {
  const suffix = classified ? "/" : "";
  const lines = ["project"];
  for (let directory = 0; directory < 42; directory++) {
    lines.push(`${directory === 41 ? "└──" : "├──"} dir-${directory}${suffix}`);
    lines.push(`│   └── file-${directory}.ts`);
  }
  lines.push("42 directories, 42 files");
  return lines;
}

describe("twelfth audit regressions", () => {
  test("tree aborts before near-limit node and allocation budgets overflow", () => {
    const text = broadTree(true).join("\n");
    const input = scanText(text);
    if (input === undefined) throw new Error("expected bounded text");
    expect(input.budget.chargeRecords(99_850)).toBe(true);
    expect(compressListing(input, "tree", "classified")).toBe(text);
  });

  test("plain ambiguous omitted leaves fail open while classified tree counts exactly", () => {
    const plain = broadTree(false);
    plain.splice(43, 0, "│   ├── empty-middle");
    const unchanged = run("tree", plain);
    expect(unchanged.output.request).toBe(unchanged.input);

    expect(classifyCommand("tree -F")?.subcommand).toBe("classified");
    expect(classifyCommand("tree --classify")?.subcommand).toBe("classified");
    const classified = run("tree -F", broadTree(true));
    expect(classified.output.report.filters).toContain("tree-output");
    expect(classified.content).toContain("... 30 directories omitted containing 30 entries ...");
  });

  test("long git status preserves relation operation conflicts and state records", () => {
    const relations = [
      "Your branch is ahead of 'origin/main' by 2 commits.",
      "Your branch is behind 'origin/main' by 3 commits, and can be fast-forwarded.",
      "Your branch and 'origin/main' have diverged,",
      "and have 2 and 3 different commits each, respectively.",
    ];
    const records = Array.from({ length: 35 }, (_, index) => `\tmodified:   src/file-${index}.ts`);
    const fixture = run("git status", [
      "HEAD detached at abc1234",
      ...relations,
      "You are currently rebasing branch 'main' on 'abc1234'.",
      "All conflicts fixed but you are still merging.",
      "Unmerged paths:",
      '  (use "git add <file>..." to mark resolution)',
      "\tboth modified:   src/conflict.ts",
      "Changes to be committed:",
      "\trenamed:    src/old.ts -> src/new.ts",
      "\tcopied:     src/source.ts -> src/copy.ts",
      ...records,
      'no changes added to commit (use "git add" and/or "git commit -a")',
    ]);
    expect(fixture.output.report.filters).toContain("git-status");
    for (const line of [
      ...relations,
      "You are currently rebasing branch 'main' on 'abc1234'.",
      "All conflicts fixed but you are still merging.",
      "\tboth modified:   src/conflict.ts",
      "\trenamed:    src/old.ts -> src/new.ts",
      "\tcopied:     src/source.ts -> src/copy.ts",
      "\tmodified:   src/file-20.ts",
    ])
      expect(fixture.content).toContain(line);
  });
});
