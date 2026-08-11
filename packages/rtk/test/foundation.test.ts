import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { isRtkFilterId, RTK_FILTER_IDS } from "../src/catalog.ts";
import { classifyCommand } from "../src/command.ts";
import { extractCommand, transformRequest } from "../src/index.ts";

function request(name: string, command: unknown, content: string): ChatRequest {
  return {
    model: "fast",
    stream: false,
    messages: [
      { role: "assistant", content: [{ type: "toolUse", id: "call", name, input: command }] },
      { role: "user", content: [{ type: "toolResult", toolUseId: "call", content }] },
    ],
  };
}

const longRows = (row: string, count = 100): string =>
  Array.from({ length: count }, () => row).join("\n");

describe("RTK catalog", () => {
  test("exports all approved family IDs and validates only members", () => {
    expect(RTK_FILTER_IDS).toHaveLength(15);
    for (const id of RTK_FILTER_IDS) expect(isRtkFilterId(id)).toBe(true);
    expect(isRtkFilterId("docker-run")).toBe(false);
    expect(isRtkFilterId(1)).toBe(false);
  });
});

describe("bounded command classification", () => {
  test("recognizes exact commands through approved wrappers", () => {
    expect(
      classifyCommand("cd 'some dir' && NODE_ENV=test timeout -s TERM 30s bun run test:unit")
        ?.family,
    ).toBe("test-output");
    expect(classifyCommand("env -i CI=1 -- bunx --bun biome check .")?.family).toBe("lint-output");
    expect(classifyCommand("npx -y -- eslint src")?.family).toBe("lint-output");
    expect(classifyCommand("git different-command")).toBeUndefined();
  });

  test("fails closed for shell composition, malformed input, and bounds", () => {
    for (const command of [
      "git status | cat",
      "bun test && echo done",
      "docker build . > log",
      "bun run",
      "'unterminated",
      "x ".repeat(257),
      "x".repeat(16_385),
    ])
      expect(classifyCommand(command)).toBeUndefined();
  });
});

describe("foundation hardening", () => {
  test("extracts only primitive or own plain-object command fields in precedence order", () => {
    expect(extractCommand("git status")).toBe("git status");
    expect(extractCommand({ command: "first", cmd: "second" })).toBe("first");
    expect(extractCommand({ command: 1, cmd: "second" })).toBe("second");
    expect(extractCommand(Object.create({ command: "inherited" }) as object)).toBeUndefined();
    expect(extractCommand(["git status"])).toBeUndefined();
  });

  test("requires multiple anchors for unknown Git output", () => {
    const weak = request("mystery", {}, `commit deadbeef\n${longRows("prose about code")}`);
    expect(transformRequest(weak, { enabled: true }).request).toBe(weak);
    const strong = request(
      "mystery",
      {},
      `commit deadbeef\nAuthor: Dev <dev@example.test>\nDate: today\n\n    subject\n${longRows("detail")}`,
    );
    expect(transformRequest(strong, { enabled: true }).report.filters).toContain("git-log");
  });

  test("uses exact shell aliases and expanded non-shell exclusions", () => {
    const content = longRows("duplicate diagnostic", 600);
    expect(
      transformRequest(request("execute.sql", { command: "echo x" }, content), { enabled: true })
        .request.messages,
    ).toEqual(request("execute.sql", { command: "echo x" }, content).messages);
    for (const name of ["read_file", "list_directory", "find_files", "code_search", "apply_patch"])
      expect(
        transformRequest(request(name, { command: "echo x" }, content), { enabled: true }).report
          .applied,
      ).toBe(false);
  });

  test("honors exact size boundaries and copy-on-write identity", () => {
    const below = request("bash", { command: "echo x" }, "x".repeat(499));
    expect(transformRequest(below, { enabled: true }).request).toBe(below);
    const over = request("bash", { command: "echo x" }, "x".repeat(1_000_001));
    expect(transformRequest(over, { enabled: true }).request).toBe(over);

    const input = request("bash", { command: "echo x" }, longRows("same", 600));
    input.messages.push({ role: "user", content: [{ type: "text", text: "untouched" }] });
    const output = transformRequest(input, { enabled: true }).request;
    expect(output.messages[0]).toBe(input.messages[0]);
    expect(output.messages[2]).toBe(input.messages[2]);
    const outputUse = output.messages[0]?.content[0];
    const inputUse = input.messages[0]?.content[0];
    if (outputUse?.type !== "toolUse" || inputUse?.type !== "toolUse")
      throw new Error("expected tool uses");
    expect(outputUse.input).toBe(inputUse.input);
  });
});
