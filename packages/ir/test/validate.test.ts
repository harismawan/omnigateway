import { expect, test } from "bun:test";
import type { ChatRequest } from "../src/request.ts";
import { validateRequest } from "../src/validate.ts";

const base = (messages: ChatRequest["messages"]): ChatRequest => ({
  model: "m",
  messages,
  stream: false,
});

test("drops toolResult blocks with no matching toolUse", () => {
  const out = validateRequest(
    base([
      {
        role: "user",
        content: [
          { type: "toolResult", toolUseId: "ghost", content: "x" },
          { type: "text", text: "keep me" },
        ],
      },
    ]),
  );
  expect(out.messages[0]?.content).toEqual([{ type: "text", text: "keep me" }]);
});

test("keeps toolResult blocks whose toolUse appeared earlier", () => {
  const out = validateRequest(
    base([
      { role: "assistant", content: [{ type: "toolUse", id: "t1", name: "f", input: {} }] },
      {
        role: "user",
        content: [{ type: "toolResult", toolUseId: "t1", content: "ok" }],
      },
    ]),
  );
  expect(out.messages[1]?.content).toHaveLength(1);
});

test("synthesizes ids for toolUse blocks that lack them", () => {
  const out = validateRequest(
    base([{ role: "assistant", content: [{ type: "toolUse", id: "", name: "f", input: {} }] }]),
  );
  const block = out.messages[0]?.content[0];
  expect(block?.type).toBe("toolUse");
  expect(block?.type === "toolUse" && block.id.length > 0).toBe(true);
});

test("merges adjacent messages that share a role", () => {
  const out = validateRequest(
    base([
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "c" }] },
    ]),
  );
  expect(out.messages).toHaveLength(2);
  expect(out.messages[0]?.content).toHaveLength(2);
});

test("drops messages left empty after filtering", () => {
  const out = validateRequest(
    base([
      { role: "user", content: [{ type: "toolResult", toolUseId: "ghost", content: "" }] },
      { role: "user", content: [{ type: "text", text: "real" }] },
    ]),
  );
  expect(out.messages).toHaveLength(1);
  expect(out.messages[0]?.content).toEqual([{ type: "text", text: "real" }]);
});

test("does not mutate the input request", () => {
  const input = base([
    { role: "user", content: [{ type: "text", text: "a" }] },
    { role: "user", content: [{ type: "text", text: "b" }] },
  ]);
  validateRequest(input);
  expect(input.messages).toHaveLength(2);
});

/**
 * The id generator is a parameter so this package can be deterministic.
 *
 * `packages/ir` is required to be side-effect-free, and a bare
 * `crypto.randomUUID()` made the one function that rewrites a request answer
 * differently for identical input. The seam existed for a while with no caller
 * and no test, which is the same as not having it: nothing demonstrated that
 * passing a generator changed anything.
 */
test("an injected generator makes identical requests validate identically", () => {
  const counter = () => {
    let n = 0;
    return () => `tu_fixed_${++n}`;
  };

  const withEmptyIds = () =>
    base([
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "", name: "Read", input: {} },
          { type: "toolUse", id: "", name: "Write", input: {} },
        ],
      },
    ]);

  const first = validateRequest(withEmptyIds(), counter());
  const second = validateRequest(withEmptyIds(), counter());

  expect(first).toEqual(second);
  // And the ids are the generator's, not the default's — a run that ignored the
  // parameter would still satisfy the equality above only by accident.
  const ids = first.messages[0]?.content.flatMap((block) =>
    block.type === "toolUse" ? [block.id] : [],
  );
  expect(ids).toEqual(["tu_fixed_1", "tu_fixed_2"]);
});
