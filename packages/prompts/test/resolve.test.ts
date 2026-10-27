import { expect, test } from "bun:test";
import { builtinPrompts, type ResolvedPrompt, resolvePrompts } from "../src/index.ts";

const active = new Map<string, ResolvedPrompt>([
  ...builtinPrompts().map((prompt): [string, ResolvedPrompt] => [prompt.id, prompt]),
  ...["a", "b", "constructor"].map((id): [string, ResolvedPrompt] => [
    id,
    { id, version: 2, text: `${id} rules` },
  ]),
]);

test("effective resolution keeps first occurrence and global then key order", () => {
  const result = resolvePrompts(
    ["a", "b"],
    { ids: ["b", "constructor"], inheritGlobal: true },
    active,
  );
  expect(result.prompts.map(({ id }) => id)).toEqual(["a", "b", "constructor"]);
  expect(result.notes).toEqual([]);
});

test("inherit off excludes global prompts and missing notes", () => {
  const result = resolvePrompts(["a", "missing"], { ids: ["b"], inheritGlobal: false }, active);
  expect(result.prompts.map(({ id }) => id)).toEqual(["b"]);
  expect(result.notes).toEqual([]);
});

test("key built-in overrides global built-in but retains user order", () => {
  const result = resolvePrompts(
    ["a", "ponytail-full", "b"],
    {
      ids: ["ponytail-lite", "a"],
      inheritGlobal: true,
    },
    active,
  );
  expect(result.prompts.map(({ id }) => id)).toEqual(["a", "b", "ponytail-lite"]);
});

test("same built-in in both lists retains first occurrence position", () => {
  const result = resolvePrompts(
    ["ponytail-full", "a"],
    {
      ids: ["b", "ponytail-full"],
      inheritGlobal: true,
    },
    active,
  );
  expect(result.prompts.map(({ id }) => id)).toEqual(["ponytail-full", "a", "b"]);
});

test("missing and inactive IDs skip with one constant note", () => {
  const result = resolvePrompts(
    ["missing", "a", "inactive"],
    {
      ids: ["missing", "absent", "b"],
      inheritGlobal: true,
    },
    active,
  );
  expect(result.prompts.map(({ id }) => id)).toEqual(["a", "b"]);
  expect(result.notes).toEqual(["prompt:missing"]);
});

test("resolution normalizes corrupt persisted lists before precedence", () => {
  const globals = Object.freeze(["a", "ponytail-full", "ponytail-ultra", "bad_id", "a"]);
  const assignment = {
    ids: ["ponytail-bad", "ponytail-lite", "ponytail-full", "b"],
    inheritGlobal: true,
  };
  Object.freeze(assignment.ids);
  Object.freeze(assignment);
  expect(resolvePrompts(globals, assignment, active).prompts.map(({ id }) => id)).toEqual([
    "a",
    "ponytail-lite",
    "b",
  ]);
});
