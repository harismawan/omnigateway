import { expect, test } from "bun:test";
import { VERDICT_TTL_MS, VerdictCache, verdictKey } from "../../src/guardrail/cache.ts";

const parts = {
  apiKeyId: "k1",
  policy: "Work only.",
  model: "judge",
  system: "sys",
  human: "ask",
};

test("the key changes with every part, and does not concatenate ambiguously", () => {
  const base = verdictKey(parts);
  for (const field of ["apiKeyId", "policy", "model", "system", "human"] as const) {
    expect(verdictKey({ ...parts, [field]: `${parts[field]}!` })).not.toBe(base);
  }
  expect(verdictKey({ ...parts, system: "ab", human: "c" })).not.toBe(
    verdictKey({ ...parts, system: "a", human: "bc" }),
  );
  expect(verdictKey({ ...parts })).toBe(base);
  // The key holds no request text.
  expect(base).toMatch(/^[0-9a-f]{64}$/);
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
