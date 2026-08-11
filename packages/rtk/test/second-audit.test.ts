import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { classifyCommand } from "../src/command.ts";
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

const noise = (count = 100) => Array.from({ length: count }, (_, index) => `progress ${index}`);

describe("second audit regressions", () => {
  test("git status preserves porcelain states, paths, pairs, and operation markers", () => {
    const records = [
      "## HEAD (no branch)",
      "rebase in progress; onto abc1234",
      " M path with spaces.ts",
      "?? untracked file.ts",
      "UU conflicted.ts",
      "R  old name.ts -> new name.ts",
      "C  source.ts -> copy.ts",
    ];
    const chatter = Array.from(
      { length: 100 },
      () => "  (use git add to update what will be committed)",
    );
    const result = run("git status --short --branch", [
      records[0] ?? "",
      ...chatter,
      ...records.slice(1),
    ]);
    expect(result.output.report.filters).toContain("git-status");
    for (const record of records) expect(result.content).toContain(record);
    const unknown = run("git status --short", ["## main", ...chatter, "ZZ impossible.ts"]);
    expect(unknown.output.request).toBe(unknown.input);
  });

  test("tree accepts only root, hierarchy, and supported summary", () => {
    const children = Array.from(
      { length: 40 },
      (_, index) => `│   ├── descriptive-file-name-${index}.ts`,
    );
    const valid = ["project", "├── src/", ...children, "└── test/", "2 directories, 40 files"];
    const result = run("tree -F", valid);
    expect(result.output.report.filters).toContain("tree-output");
    for (const line of [valid[0], valid[1], valid.at(-1)])
      expect(result.content).toContain(line ?? "");
    expect(result.content).toContain("... 28 entries omitted from project/src ...");
    const prose = run("tree", [
      "project",
      "This prose was previously accepted",
      ...noise(),
      "1 directory, 0 files",
    ]);
    expect(prose.output.request).toBe(prose.input);
    const malformed = run("tree", ["project", "│   └── orphan.ts", "0 directories, 1 file"]);
    expect(malformed.output.request).toBe(malformed.input);
  });

  test("unknown-origin path lists use exact grouped omission units", () => {
    const paths = Array.from({ length: 50 }, (_, index) => `./src/file-${index}.ts`);
    const result = run("ignored", paths, "mystery");
    expect(result.output.report.filters).toContain("path-list");
    expect(result.content).toContain("... 38 entries omitted from ./src ...");
    expect(result.content).not.toContain("lines omitted");
  });

  test("unknown build and test inference requires distinct subtype rows", () => {
    const weakTest = run("ignored", ["bun test v1.4.0 1 pass", ...noise()], "mystery");
    expect(weakTest.output.request).toBe(weakTest.input);
    const cases = Array.from(
      { length: 120 },
      (_, index) => `descriptive test case ${index} completed successfully`,
    );
    const strongTest = run(
      "ignored",
      ["bun test v1.4.0", ...cases, "1 pass", "Ran 1 test across 1 file"],
      "mystery",
    );
    expect(strongTest.output.report.filters).toContain("test-output");
    const install = run(
      "ignored",
      ["bun install v1.4.0", ...noise(), "installed 20 packages", "Saved lockfile"],
      "mystery",
    );
    expect(install.output.report.filters).not.toContain("build-output");
  });

  test("warning identity deduplicates complete blocks before capping", () => {
    const duplicate = ["src/a.ts(1,1): warning TS1000: duplicate", "  duplicate detail"];
    const unique = Array.from({ length: 21 }, (_, index) => [
      `src/u${index}.ts(${index + 1},1): warning TS${2000 + index}: unique ${index}`,
      `  unique detail ${index}`,
    ]).flat();
    const result = run("tsc --noEmit", [
      "Version 7",
      ...noise(),
      ...duplicate,
      ...duplicate,
      ...unique,
      "Found 0 errors and 23 warnings.",
    ]);
    expect(result.content.match(/duplicate detail/g)).toHaveLength(1);
    expect(result.content).toContain("... 2 warnings omitted ...");
  });

  test("rejects separated and equals structured reporter options", () => {
    for (const command of [
      "eslint --format json src",
      "eslint --format=json src",
      "biome check --reporter json .",
      "biome check --reporter=json .",
      "ruff check --output-format json .",
      "ruff check --output-format=json .",
      "eslint --format sarif src",
      "biome check --reporter custom .",
    ])
      expect(classifyCommand(command)).toBeUndefined();
  });

  test("ls preserves one total header and rejects duplicate or misplaced headers", () => {
    const rows = Array.from(
      { length: 20 },
      (_, index) => `-rw-r--r-- 1 u g 10 Aug 10 12:00 file-${index}.ts`,
    );
    const valid = run("ls -la", ["total 200", ...rows]);
    expect(valid.content.startsWith("total 200\n")).toBe(true);
    expect(valid.content).toContain("... 8 entries omitted from . ...");
    for (const lines of [
      ["total 200", ...rows, "total 100"],
      [...rows, "total 200"],
    ]) {
      const invalid = run("ls -la", lines);
      expect(invalid.output.request).toBe(invalid.input);
    }
  });
});
