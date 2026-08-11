import { expect, test } from "bun:test";
import type { AnthropicToolFamily } from "@omni/ir";
import {
  ANTHROPIC_NATIVE_BLOCK_TYPES,
  ANTHROPIC_TOOL_SPECS,
  anthropicToolSpec,
} from "../src/anthropic/tools.ts";

const FAMILIES: readonly AnthropicToolFamily[] = [
  "webSearch",
  "webFetch",
  "codeExecution",
  "bash",
  "textEditor",
  "computer",
  "memory",
  "toolSearchRegex",
  "toolSearchBm25",
  "advisor",
  "mcpToolset",
];

test("every documented family is represented by at least one version", () => {
  const covered = new Set(Object.values(ANTHROPIC_TOOL_SPECS).map((s) => s.family));
  expect([...covered].sort()).toEqual([...FAMILIES].sort());
});

test("documented legacy versions stay accepted", () => {
  for (const type of [
    "bash_20241022",
    "computer_20241022",
    "text_editor_20241022",
    "text_editor_20250429",
    "code_execution_20250522",
  ]) {
    expect(anthropicToolSpec(type)?.family).toBeDefined();
  }
});

test("each version pins the fixed name Anthropic pairs with it", () => {
  expect(anthropicToolSpec("text_editor_20250124")?.name).toBe("str_replace_editor");
  expect(anthropicToolSpec("text_editor_20250429")?.name).toBe("str_replace_based_edit_tool");
  expect(anthropicToolSpec("web_search_20250305")?.name).toBe("web_search");
  // The toolset entry is the one family Anthropic gives no fixed name.
  expect(anthropicToolSpec("mcp_toolset")?.name).toBeUndefined();
});

test("version-specific options are restricted to the versions that define them", () => {
  expect(anthropicToolSpec("computer_20251124")?.optional).toContain("enable_zoom");
  expect(anthropicToolSpec("computer_20250124")?.optional).not.toContain("enable_zoom");
  expect(anthropicToolSpec("text_editor_20250728")?.optional).toContain("max_characters");
  expect(anthropicToolSpec("text_editor_20250429")?.optional).not.toContain("max_characters");
  expect(anthropicToolSpec("web_fetch_20260309")?.optional).toContain("use_cache");
  expect(anthropicToolSpec("web_fetch_20250910")?.optional).not.toContain("use_cache");
});

test("required family fields are named", () => {
  expect(anthropicToolSpec("computer_20250124")?.required).toEqual([
    "display_width_px",
    "display_height_px",
  ]);
  expect(anthropicToolSpec("advisor_20260301")?.required).toEqual(["model"]);
  expect(anthropicToolSpec("mcp_toolset")?.required).toEqual(["mcp_server_name"]);
  expect(anthropicToolSpec("bash_20250124")?.required).toEqual([]);
});

test("an unknown dated type is not resolved by prefix", () => {
  expect(anthropicToolSpec("bash_20991231")).toBeUndefined();
  expect(anthropicToolSpec("web_search")).toBeUndefined();
});

test("undated tool-search aliases are accepted alongside their dated form", () => {
  expect(anthropicToolSpec("tool_search_tool_regex")?.family).toBe("toolSearchRegex");
  expect(anthropicToolSpec("tool_search_tool_bm25_20251119")?.family).toBe("toolSearchBm25");
});

test("native block types cover server tool use and every documented result family", () => {
  for (const t of [
    "server_tool_use",
    "web_search_tool_result",
    "web_fetch_tool_result",
    "code_execution_tool_result",
    "bash_code_execution_tool_result",
    "text_editor_code_execution_tool_result",
    "mcp_tool_use",
    "mcp_tool_result",
    "tool_search_tool_result",
    "tool_reference",
    "advisor_tool_result",
    "container_upload",
    "redacted_thinking",
  ]) {
    expect(ANTHROPIC_NATIVE_BLOCK_TYPES.has(t)).toBe(true);
  }
  // The portable four are not native blocks; they keep their own IR variants.
  for (const t of ["text", "image", "thinking", "tool_use", "tool_result"]) {
    expect(ANTHROPIC_NATIVE_BLOCK_TYPES.has(t)).toBe(false);
  }
});
