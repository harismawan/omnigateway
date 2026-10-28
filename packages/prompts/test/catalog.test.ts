import { expect, test } from "bun:test";
import { PONYTAIL_MARKER, rulesetFor } from "@omni/ponytail";
import { isPromptId, readPromptAssignment, readPromptIds } from "../src/catalog.ts";
import { builtinPrompts, injectPrompts } from "../src/index.ts";

test("stored IDs reject invalid and reserved slugs without property lookup", () => {
  for (const id of ["a", "0", "-", "a".repeat(40), "constructor", "ponytail-lite"]) {
    expect(isPromptId(id)).toBe(true);
  }
  for (const id of [null, 3, "", "A", "a_b", "a".repeat(41), "ponytail-unknown"]) {
    expect(isPromptId(id)).toBe(false);
  }
  expect(
    readPromptIds(["a", null, "a", "ponytail-full", "ponytail-lite", "b", "c", "d", "e"]),
  ).toEqual(["a", "ponytail-full", "b", "c", "d"]);
});

test("stored wrong containers default safely and do not share mutable defaults", () => {
  for (const value of [null, undefined, "[broken", 42, [], true]) {
    expect(readPromptAssignment(value)).toEqual({ ids: [], inheritGlobal: true });
    expect(readPromptIds(value)).toEqual([]);
  }
  expect(readPromptAssignment({ ids: ["a", "a"], inheritGlobal: false })).toEqual({
    ids: ["a"],
    inheritGlobal: false,
  });
  expect(readPromptAssignment({ ids: "a", inheritGlobal: "false" })).toEqual({
    ids: [],
    inheritGlobal: true,
  });
  const first = readPromptAssignment(null);
  first.ids.push("changed");
  expect(readPromptAssignment(null).ids).toEqual([]);
});

test("built-ins expose pinned public rulesets and shared marker semantics", () => {
  const builtins = builtinPrompts();
  expect(builtins.map(({ id, version, marker }) => ({ id, version, marker }))).toEqual([
    { id: "ponytail-lite", version: "v4.9.0", marker: PONYTAIL_MARKER },
    { id: "ponytail-full", version: "v4.9.0", marker: PONYTAIL_MARKER },
    { id: "ponytail-ultra", version: "v4.9.0", marker: PONYTAIL_MARKER },
  ]);
  for (const [index, level] of (["lite", "full", "ultra"] as const).entries()) {
    expect(builtins[index]?.text).toBe(rulesetFor(level));
  }
  const request = { model: "fast", stream: false, messages: [] };
  const result = injectPrompts(request, builtins);
  expect(result.report.applied).toEqual([{ id: "ponytail-lite", version: "v4.9.0" }]);
  expect(result.report.skipped).toHaveLength(2);
});
