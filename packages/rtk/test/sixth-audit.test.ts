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
const noise = Array.from({ length: 100 }, (_, index) => `progress ${index}`);

describe("sixth audit regressions", () => {
  test("Bun preserves unhandled hook failure causes and stacks", () => {
    const anchors = [
      "UnhandledPromiseRejection: hook failed",
      "Caused by: Error: database unavailable",
      "    at beforeAll (test/setup.ts:12:3)",
      "error: 1 unhandled rejection",
      "1 fail",
      "Ran 1 test across 1 file",
    ];
    const fixture = run("bun test", ["bun test v1.4.0", ...noise, ...anchors, ...noise]);
    for (const anchor of anchors) expect(fixture.content).toContain(anchor);
  });

  test("Go preserves package build failures and compiler diagnostics", () => {
    const anchors = [
      "# example/pkg",
      "pkg/file.go:10:2: undefined: missing",
      "FAIL example/pkg [build failed]",
    ];
    const fixture = run("go test ./...", ["go test", ...noise, ...anchors, ...noise]);
    for (const anchor of anchors) expect(fixture.content).toContain(anchor);
  });

  test("nonzero summary without a complete failure block retains original", () => {
    for (const [command, summary] of [
      ["bun test", "1 fail"],
      ["vitest run", "Tests 1 failed"],
      ["jest", "Tests: 1 failed"],
      ["pytest", "1 failed in 1s"],
      ["go test ./...", "FAIL example/pkg 1s"],
    ]) {
      const fixture = run(command ?? "", ["runner", ...noise, summary ?? ""]);
      expect(fixture.output.request).toBe(fixture.input);
    }
  });

  test("Docker rejects unknown rows and preserves semantic identities", () => {
    const unknown = run("docker build .", [
      "#1 [1/2] FROM alpine",
      ...noise,
      "CUSTOM artifact maybe",
      "#2 DONE",
    ]);
    expect(unknown.output.request).toBe(unknown.input);
    const semantic = run("docker build .", [
      "#1 [1/2] FROM alpine@sha256:base",
      ...Array.from({ length: 100 }, () => "#1 1.0 50% transferring"),
      "#2 ERROR: process failed",
      "#2   command: bun build",
      "#2   caused by missing.ts",
      "#3 naming to app:latest",
      "#3 digest: sha256:final",
    ]);
    for (const anchor of [
      "FROM alpine@sha256:base",
      "ERROR: process failed",
      "command: bun build",
      "caused by missing.ts",
      "naming to app:latest",
      "digest: sha256:final",
    ])
      expect(semantic.content).toContain(anchor);
  });

  test("build rejects unknown rows and preserves counted recognized classes", () => {
    const unknown = run("bun build src/a.ts", [
      "bun build v1",
      ...noise,
      "CUSTOM compiler extension",
      "Build completed in 1s",
    ]);
    expect(unknown.output.request).toBe(unknown.input);
    const cargo = run("cargo build", [
      "Compiling a v1",
      "Compiling b v1",
      ...Array.from({ length: 50 }, () => "Compiling repeated v1"),
      "Running `rustc src/main.rs`",
      "target/debug/app",
      "Finished dev target in 1s",
    ]);
    for (const anchor of [
      "Compiling a v1",
      "Compiling b v1",
      "Running `rustc",
      "target/debug/app",
      "Finished dev target",
    ])
      expect(cargo.content).toContain(anchor);
  });

  test("specialized parsers do not report generic post-dedup hits", () => {
    const fixture = run("bun test", [
      "bun test v1",
      ...noise,
      "  FAIL case",
      "error: boom",
      "    at test/a.ts:1:1",
      "1 fail",
      "Ran 1 test across 1 file",
    ]);
    expect(fixture.output.report.filters).toEqual(["test-output"]);
    expect(fixture.output.report.filterHits).toBe(1);
  });

  test("aggregate parser budget rejects near-limit diagnostic records", () => {
    const diagnostics = Array.from({ length: 40_000 }, (_, index) => [
      `src/f${index}.ts(1,1): warning TS1000: warning ${index}`,
      "  detail",
    ]).flat();
    const fixture = run("tsc --noEmit", [...diagnostics, "Found 0 errors and 40000 warnings."]);
    expect(fixture.output.request).toBe(fixture.input);
  });
});
