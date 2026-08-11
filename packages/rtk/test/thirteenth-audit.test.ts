import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { compressListing } from "../src/filters/listings.ts";
import { scanText } from "../src/filters/shared.ts";
import { compressGitStatus } from "../src/filters/status.ts";
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

describe("thirteenth audit regressions", () => {
  test("command-gated relative paths accept files and reject ambiguous content", () => {
    const valid = [
      "README.md",
      "src/index.ts",
      "packages/rtk/src/index.ts",
      ...Array.from(
        { length: 100 },
        (_, index) => `descriptive-relative-file-${index}-${"detail-".repeat(3)}.ts`,
      ),
    ];
    expect(run("git ls-files", valid).output.report.filters).toContain("path-list");
    for (const invalid of [
      ["Build failed because dependency missing", ...valid],
      ["src/index.ts:10:error", ...valid],
      ["NAME VALUE", ...valid],
      ['{"path":"src/index.ts"}', ...valid],
      ["```", ...valid],
    ]) {
      const fixture = run("git ls-files", invalid);
      expect(fixture.output.request).toBe(fixture.input);
    }
  });

  test("unknown-origin relative paths require density and conflict gates", () => {
    const relative = Array.from(
      { length: 30 },
      (_, index) => `src/descriptive-relative-file-${index}.ts`,
    );
    expect(run("ignored", relative, "mystery").output.report.filters).toContain("path-list");
    const conflicted = [
      ...relative.slice(0, 20),
      ...Array.from({ length: 10 }, () => "This is prose"),
    ];
    const fixture = run("ignored", conflicted, "mystery");
    expect(fixture.output.request).toBe(fixture.input);
  });

  test("listing parsers fail open at near-limit allocation budgets", () => {
    for (const [executable, subcommand, text] of [
      [
        "git",
        "ls-files",
        Array.from({ length: 100 }, (_, index) => `dir-${index}/file.ts`).join("\n"),
      ],
      [
        "git",
        "ls-files",
        Array.from({ length: 100 }, (_, index) => `src/file-${index}.ts`).join("\n"),
      ],
      [
        "ls",
        "recursive-plain",
        Array.from({ length: 50 }, (_, index) => `./dir-${index}:\nfile.ts`).join("\n"),
      ],
      [
        "ls",
        "recursive-long",
        Array.from(
          { length: 50 },
          (_, index) => `./dir-${index}:\ntotal 1\n-rw-r--r-- 1 u g 1 Aug 10 12:00 file.ts`,
        ).join("\n"),
      ],
    ] as const) {
      const input = scanText(text);
      if (input === undefined) throw new Error("expected bounded text");
      expect(input.budget.chargeRecords(99_700)).toBe(true);
      expect(compressListing(input, executable, subcommand)).toBe(text);
    }
  });

  test("git status fails open near budget for long and porcelain forms", () => {
    for (const text of [
      [
        "On branch main",
        "Changes to be committed:",
        ...Array.from({ length: 80 }, (_, index) => `\tmodified:   src/file-${index}.ts`),
        'no changes added to commit (use "git add" and/or "git commit -a")',
      ].join("\n"),
      ["## main", ...Array.from({ length: 80 }, (_, index) => ` M src/file-${index}.ts`)].join(
        "\n",
      ),
    ]) {
      const input = scanText(text);
      if (input === undefined) throw new Error("expected bounded text");
      expect(input.budget.chargeRecords(99_850)).toBe(true);
      expect(compressGitStatus(input)).toBe(text);
    }
  });
});
