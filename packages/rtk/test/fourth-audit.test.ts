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

const noise = (label: string) => Array.from({ length: 80 }, (_, index) => `${label} ${index}`);

describe("fourth audit regressions", () => {
  test.each([
    ["bun test", ["2 skip", "1 todo", "Ran 10 tests across 3 files"]],
    [
      "vitest run",
      [
        "Test Files 1 skipped | 2 passed",
        "Tests 2 todo | 3 skipped | 8 passed",
        "Snapshots 1 updated",
        "Projects 2",
        "Shard 1/2",
        "Attachments 3",
        "Retries 1",
      ],
    ],
    [
      "jest",
      [
        "Test Suites: 1 skipped, 2 passed",
        "Tests: 2 todo, 3 skipped, 8 passed",
        "Snapshots: 1 updated",
      ],
    ],
    ["pytest", ["8 passed, 3 skipped, 2 xfailed, 1 xpassed in 1.2s"]],
    ["go test ./...", ["--- SKIP: TestOptional (0.00s)", "ok example/pkg 1.2s"]],
  ])("preserves %s subtype summaries from the middle", (command, summaries) => {
    const fixture = run(command, [
      "runner start",
      ...noise("before"),
      ...summaries,
      ...noise("after"),
      command === "go test ./..." ? "    --- FAIL: TestNamed (0.00s)" : "FAIL named failure",
      "  at test/file.ts:2:3",
    ]);
    expect(fixture.output.report.filters).toContain("test-output");
    for (const summary of summaries) expect(fixture.content).toContain(summary);
  });

  test.each([
    [
      "npm install",
      [
        "npm warn ERESOLVE overriding peer dependency",
        "npm warn While resolving: app@1",
        "npm error code ERESOLVE",
        "npm error unable to resolve dependency tree",
      ],
    ],
    ["pnpm install", ["WARN deprecated package@1", "ERR_PNPM_PEER_DEP_ISSUES unmet peer"]],
    ["yarn install", ["YN0060: peer dependency warning", "YN0009: package failed to build"]],
    ["cargo fetch", ["warning: spurious network error", "error: failed to get crate"]],
    ["pip install app", ["WARNING: dependency conflict", "ERROR: Could not build wheels"]],
    ["uv sync", ["warning: resolution conflict", "error: Failed to build app"]],
  ])("preserves %s manager diagnostics", (command, diagnostics) => {
    const fixture = run(command, [
      "manager start",
      ...noise("download"),
      ...diagnostics,
      "installed 1 package",
    ]);
    expect(fixture.output.report.filters).toContain("package-output");
    for (const line of diagnostics) expect(fixture.content).toContain(line);
  });

  test("package parser rejects unassignable diagnostic-looking rows", () => {
    const fixture = run("npm install", [
      "npm start",
      ...noise("download"),
      "DIAGNOSTIC maybe bad",
      "installed 1 package",
    ]);
    expect(fixture.output.request).toBe(fixture.input);
  });

  test("Git pull parser preserves diffstat, refs, divergence, and final status", () => {
    const anchors = [
      "From github.com:acme/app",
      "abc123..def456 main -> origin/main",
      " src/a.ts | 10 +++++-----",
      " 1 file changed, 5 insertions(+), 5 deletions(-)",
      "Your branch and 'origin/main' have diverged",
      "CONFLICT (content): Merge conflict in src/a.ts",
      "Automatic merge failed; fix conflicts and then commit the result.",
    ];
    const fixture = run("git pull", [
      anchors[0] ?? "",
      ...noise("remote progress"),
      ...anchors.slice(1),
    ]);
    expect(fixture.output.report.filters).toContain("git-operation");
    for (const anchor of anchors) expect(fixture.content).toContain(anchor);
    const unknown = run("git fetch", [
      "From origin",
      ...noise("Counting objects"),
      "mystery non-progress row",
    ]);
    expect(unknown.output.request).toBe(unknown.input);
  });

  test("warning identity ignores differing source frames for the same tuple", () => {
    const first = ["src/a.ts(1,2): warning TS1000: duplicate", "  const a = 1", "  ^ first"];
    const second = ["src/a.ts(1,2): warning TS1000: duplicate", "  const a = 2", "  ^ second"];
    const fixture = run("tsc --noEmit", [
      "Version 7",
      ...noise("compile"),
      ...first,
      ...second,
      "Found 0 errors and 2 warnings.",
    ]);
    expect(fixture.content).toContain("const a = 1");
    expect(fixture.content).not.toContain("const a = 2");
    expect(fixture.content).not.toContain("warnings omitted");
  });

  test("execution wrappers accept only their own nonrepeated options", () => {
    for (const command of [
      "bun x -y eslint",
      "bunx --yes eslint",
      "npx --bun eslint",
      "npx -y --yes eslint",
      "bun x --bun --bun eslint",
      "bunx -- --",
      "npx -y",
      "bun x '' biome",
    ])
      expect(classifyCommand(command)).toBeUndefined();
    expect(classifyCommand("bun x --bun biome check .")?.family).toBe("lint-output");
    expect(classifyCommand("bunx -- eslint src")?.family).toBe("lint-output");
    expect(classifyCommand("npx -y eslint src")?.family).toBe("lint-output");
  });
});
