import { expect, test } from "bun:test";
import { VERDICT_TTL_MS, VerdictCache, verdictKey } from "../../src/guardrail/cache.ts";

const parts = {
  apiKeyId: "k1",
  policy: "Work only.",
  model: "judge",
  system: "sys",
  human: ["earlier", "ask"],
  toolResults: ["output"],
};

test("the key changes with every part, and does not concatenate ambiguously", () => {
  const base = verdictKey(parts);
  for (const field of ["apiKeyId", "policy", "model", "system"] as const) {
    expect(verdictKey({ ...parts, [field]: `${parts[field]}!` })).not.toBe(base);
  }
  expect(verdictKey({ ...parts, human: ["earlier", "ask!"] })).not.toBe(base);
  expect(verdictKey({ ...parts, human: ["earlier!", "ask"] })).not.toBe(base);
  expect(verdictKey({ ...parts, system: "ab", human: ["c"] })).not.toBe(
    verdictKey({ ...parts, system: "a", human: ["bc"] }),
  );
  expect(verdictKey({ ...parts })).toBe(base);
  // The key holds no request text.
  expect(base).toMatch(/^[0-9a-f]{64}$/);
});

/**
 * Every judged message is part of the key, in order, and the boundaries
 * between them are part of it too: a key over the messages concatenated —
 * with any separator a message could itself contain — answers one split of
 * the text with another's verdict.
 */
test("the judged messages are keyed in order, and their boundaries are unambiguous", () => {
  const key = (human: string[]): string => verdictKey({ ...parts, human });
  expect(key(["ab", "c"])).not.toBe(key(["a", "bc"]));
  expect(key(["a", "b"])).not.toBe(key(["b", "a"]));
  expect(key(["a\n\nb"])).not.toBe(key(["a", "b"]));
  expect(key(["a,b"])).not.toBe(key(["a", "b"]));
  expect(key(['a","b'])).not.toBe(key(["a", "b"]));
  expect(key(["ask"])).not.toBe(key(["", "ask"]));
  expect(key(["ask"])).not.toBe(key(["earlier", "ask"]));
  expect(key([])).not.toBe(key([""]));
  expect(key(["ab", "c"])).toBe(key(["ab", "c"]));
});

/** A new tool turn changes the key, and so does a different split of the same text. */
test("tool results are part of the key", () => {
  const key = (toolResults: string[]): string => verdictKey({ ...parts, toolResults });
  expect(key(["a"])).not.toBe(key(["b"]));
  expect(key(["ab"])).not.toBe(key(["a", "b"]));
  expect(key(["a"])).not.toBe(key([]));
  expect(key(["a", "b"])).not.toBe(key(["b", "a"]));
  // Text moved between the human and tool-result arrays is a different input.
  expect(verdictKey({ ...parts, human: ["a"], toolResults: [] })).not.toBe(
    verdictKey({ ...parts, human: [], toolResults: ["a"] }),
  );
  expect(key(["a", "b"])).toBe(key(["a", "b"]));
});

test("a verdict lives for the TTL and no longer", () => {
  const cache = new VerdictCache();
  cache.set("a", "deny", 1_000);
  expect(cache.get("a", 1_000 + VERDICT_TTL_MS - 1)).toBe("deny");
  expect(cache.get("a", 1_000 + VERDICT_TTL_MS)).toBeUndefined();
  expect(cache.get("a", 1_000)).toBeUndefined();
});

test("the bound evicts the least recently used verdict", () => {
  const cache = new VerdictCache({ max: 2 });
  cache.set("a", "allow", 0);
  cache.set("b", "deny", 0);
  expect(cache.get("a", 1)).toBe("allow");
  cache.set("c", "allow", 1);
  expect(cache.get("b", 2)).toBeUndefined();
  expect(cache.get("a", 2)).toBe("allow");
  expect(cache.get("c", 2)).toBe("allow");
});
