import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { transformRequest } from "../src/index.ts";

function filter(command: string, anchors: string[]): { filters: string[]; content: string } {
  const content = [
    anchors[0],
    ...Array.from({ length: 120 }, (_, i) => `progress ${i}`),
    ...anchors.slice(1),
  ].join("\n");
  const request: ChatRequest = {
    model: "fast",
    stream: false,
    messages: [
      { role: "assistant", content: [{ type: "toolUse", id: "x", name: "bash", input: command }] },
      { role: "user", content: [{ type: "toolResult", toolUseId: "x", content }] },
    ],
  };
  const result = transformRequest(request, { enabled: true });
  const block = result.request.messages[1]?.content[0];
  if (block?.type !== "toolResult") throw new Error("expected tool result");
  return { filters: result.report.filters, content: block.content };
}

describe("package output", () => {
  test.each([
    "bun install",
    "npm update",
    "pnpm install",
    "yarn up foo",
    "cargo fetch",
    "pip install foo",
    "uv sync",
  ])("compresses %s while preserving mutations and summary", (command) => {
    const manager = command.split(" ")[0];
    const warning =
      manager === "npm"
        ? "npm warn peer conflict"
        : manager === "pnpm"
          ? "WARN peer conflict"
          : manager === "yarn"
            ? "YN0060: peer conflict"
            : manager === "pip"
              ? "WARNING: peer conflict"
              : "warning: peer conflict";
    const anchors = ["added package@1.2.3", warning, "Saved lockfile", "installed 1 package"];
    const result = filter(command, anchors);
    expect(result.filters).toContain("package-output");
    for (const anchor of anchors) expect(result.content).toContain(anchor);
  });

  test.each(["pip list", "bun pm ls", "npm view foo"])(
    "leaves unsupported inventory %s unchanged",
    (command) => {
      expect(filter(command, ["Package Version", "foo 1.0", "2 packages"]).filters).not.toContain(
        "package-output",
      );
    },
  );

  test("retains at most 20 warnings with an exact omitted count", () => {
    const warnings = Array.from({ length: 25 }, (_, i) => `warning: package conflict ${i + 1}`);
    const result = filter("bun install", [
      "Resolving packages",
      ...warnings,
      "installed 1 package",
    ]);
    expect(result.content).toContain("... 5 warnings omitted ...");
    expect(result.content).not.toContain("warning: package conflict 25");
  });
});

describe("Git operations", () => {
  test.each([
    "git branch",
    "git switch feat/x",
    "git checkout main",
    "git push",
    "git pull",
    "git fetch",
  ])("compresses %s and preserves refs and failures", (command) => {
    const anchors = [
      "* feat/x",
      "! [rejected] main -> main (non-fast-forward)",
      "error: failed to push some refs",
      "Everything up-to-date",
    ];
    const result = filter(command, anchors);
    expect(result.filters).toContain("git-operation");
    for (const anchor of anchors) expect(result.content).toContain(anchor);
  });

  test("keeps git status rename and operation markers", () => {
    const content = [
      "## feat/x",
      "rebase in progress; onto abc1234",
      "R  old.ts -> new.ts",
      ...Array.from({ length: 80 }, () => "  (use git add to update what will be committed)"),
    ].join("\n");
    const request: ChatRequest = {
      model: "fast",
      stream: false,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolUse",
              id: "status",
              name: "bash",
              input: "git status --short --branch",
            },
          ],
        },
        { role: "user", content: [{ type: "toolResult", toolUseId: "status", content }] },
      ],
    };
    const result = transformRequest(request, { enabled: true });
    expect(result.report.filters).toContain("git-status");
    const block = result.request.messages[1]?.content[0];
    if (block?.type !== "toolResult") throw new Error("expected tool result");
    expect(block.content).toContain("R  old.ts -> new.ts");
  });
});
