import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { transformRequest } from "../src/index.ts";

function run(command: string, rows: string[]): ReturnType<typeof transformRequest> {
  const content = [
    ...rows.slice(0, 2),
    ...Array.from({ length: 100 }, (_, i) => `progress ${i}`),
    ...rows.slice(2),
  ].join("\n");
  const request: ChatRequest = {
    model: "fast",
    stream: false,
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "x", name: "bash", input: { command } }],
      },
      { role: "user", content: [{ type: "toolResult", toolUseId: "x", content }] },
    ],
  };
  return transformRequest(request, { enabled: true });
}

describe("coding diagnostics", () => {
  test.each([
    ["tsc --noEmit", ["src/a.ts(2,3): error TS2322: bad", "  source", "Found 1 error."]],
    [
      "biome check .",
      [
        "src/a.ts:2:3 lint/suspicious/noFoo ERROR",
        "  detail",
        "Checked 1 file in 1ms. Found 1 error.",
      ],
    ],
    ["eslint src", ["src/a.ts", "  2:3 error bad no-foo", "✖ 1 problem (1 error, 0 warnings)"]],
    ["ruff check .", ["src/a.py:2:3: F401 unused", "  detail", "Found 1 error."]],
    ["cargo clippy", ["error[E0308]: mismatch", " --> src/a.rs:2:3", "error: could not compile"]],
    ["golangci-lint run", ["a.go:2:3: bad (govet)", "detail", "1 issues"]],
  ])("routes %s to lint-output", (command, rows) => {
    const result = run(command, rows);
    expect(result.report.filters).toContain("lint-output");
    const block = result.request.messages[1]?.content[0];
    if (block?.type !== "toolResult") throw new Error("expected tool result");
    for (const row of rows) expect(block.content).toContain(row);
  });

  test.each(["bun test", "bunx vitest", "npx jest", "pytest", "go test ./..."])(
    "routes %s to test-output",
    (command) => {
      const executable = command.includes("vitest")
        ? "vitest"
        : command.includes("jest")
          ? "jest"
          : command.startsWith("pytest")
            ? "pytest"
            : command.startsWith("go ")
              ? "go"
              : "bun";
      const failure =
        executable === "vitest"
          ? " FAIL  test/a.test.ts > named case"
          : executable === "jest"
            ? "  ● named case"
            : executable === "pytest"
              ? "  FAILED test_a.py::test_named"
              : executable === "go"
                ? "    --- FAIL: TestNamed (0.00s)"
                : "  FAIL named case";
      expect(
        run(command, [failure, "  at test/a.test.ts:2:3", "1 failed, 2 passed in 1s"]).report
          .filters,
      ).toContain("test-output");
    },
  );

  test.each(["bun build src/a.ts", "bun run build", "cargo build"])(
    "routes %s to build-output",
    (command) => {
      expect(
        run(command, ["Bundled artifact dist/a.js 2KB", "warning: middle", "Build completed in 1s"])
          .report.filters,
      ).toContain("build-output");
    },
  );

  test("does not command-gate unknown-origin lint prose", () => {
    const result = run("echo prose", [
      "src/a.ts(2,3): error TS2322: quoted prose",
      "text",
      "Found 1 error.",
    ]);
    expect(result.report.filters).not.toContain("lint-output");
  });
});
