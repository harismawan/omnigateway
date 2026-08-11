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

describe("seventh audit regressions", () => {
  test("classifies grep modes and compresses short Windows context output", () => {
    const classification = classifyCommand("rg -n -C 2 pattern src");
    expect(classification?.family).toBe("grep");
    expect(classification?.grepMode).toEqual({
      heading: false,
      lineNumber: true,
      beforeContext: 2,
      afterContext: 2,
    });
    const lines = [
      "C:\\repo\\src\\a.ts-8-before",
      "C:\\repo\\src\\a.ts:10:match one",
      "C:\\repo\\src\\a.ts-11-after",
      "--",
      "C:\\repo\\src\\a.ts:20:match two",
      ...Array.from({ length: 30 }, (_, index) => `C:\\repo\\src\\a.ts-${21 + index}-long-context`),
    ];
    const fixture = run("rg -n -C 2 pattern src", lines);
    expect(fixture.output.report.filters).toContain("grep");
    for (const anchor of [lines[0], lines[1], lines[4]])
      expect(fixture.content).toContain(anchor ?? "");
  });

  test("supports heading grep and rejects unsupported grep forms", () => {
    const heading = run("rg --heading -n pattern src", [
      "src/a.ts",
      "10:match",
      ...Array.from(
        { length: 40 },
        (_, index) => `${index + 11}:other descriptive matched content`,
      ),
    ]);
    expect(heading.output.report.filters).toContain("grep");
    expect(heading.content).toContain("src/a.ts");
    for (const command of [
      "rg --json pattern",
      "rg --files",
      "grep -P pattern file",
      "rg pattern | cat",
      "rg --replace x pattern",
    ])
      expect(classifyCommand(command)).toBeUndefined();
  });

  test("parses recursive ls groups with exact omitted directories and entries", () => {
    const lines: string[] = [];
    for (let group = 0; group < 42; group++) {
      lines.push(`./dir-${group}:`, `total ${group + 1}`);
      const count = group === 20 ? 3 : group === 21 ? 7 : 1;
      for (let entry = 0; entry < count; entry++)
        lines.push(`-rw-r--r-- 1 u g 10 Aug 10 12:00 file-${group}-${entry}.ts`);
      lines.push("");
    }
    const fixture = run("ls -lR .", lines);
    expect(fixture.output.report.filters).toContain("tree-output");
    expect(fixture.content).toContain("... 2 directories omitted containing 10 entries ...");
    expect(fixture.content).toContain("./dir-0:");
    expect(fixture.content).toContain("./dir-41:");
  });

  test("recursive ls malformed groups retain original identity", () => {
    for (const lines of [
      ["total 1", "-rw-r--r-- 1 u g 10 Aug 10 12:00 orphan"],
      ["./a:", "total 1", "unassignable row"],
      ["./a:", "./b:", "total 1"],
    ]) {
      const fixture = run("ls -lR .", [...lines, ...Array.from({ length: 40 }, () => "")]);
      expect(fixture.output.request).toBe(fixture.input);
    }
  });

  test("near-limit listing, status, Git, and package records share one budget", () => {
    const cases: Array<[string, string[]]> = [
      ["find .", Array.from({ length: 60_000 }, (_, index) => `./g${index}/file.ts`)],
      [
        "git status --short --branch",
        ["## main", ...Array.from({ length: 60_000 }, (_, index) => ` M file-${index}.ts`)],
      ],
      [
        "git fetch",
        [
          "From origin",
          ...Array.from(
            { length: 60_000 },
            (_, index) => `abc${index}..def${index} branch${index} -> origin/branch${index}`,
          ),
        ],
      ],
      [
        "npm install",
        [
          ...Array.from({ length: 60_000 }, (_, index) => `npm warn W${index} warning ${index}`),
          "installed 1 package",
        ],
      ],
    ];
    for (const [command, lines] of cases) {
      const fixture = run(command, lines);
      expect(fixture.output.request).toBe(fixture.input);
    }
  });

  test("legacy filters reject aggregate budget overflow", () => {
    const numbered = run(
      "nl file",
      Array.from({ length: 60_000 }, (_, index) => `${index + 1} | line`),
    );
    expect(numbered.output.request).toBe(numbered.input);
    const log = run(
      "echo x",
      Array.from({ length: 60_000 }, (_, index) => `line ${index}`),
    );
    expect(log.output.request).toBe(log.input);
  });
});
