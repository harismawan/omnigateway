import { expect, test } from "bun:test";
import { VerdictCache } from "../../src/guardrail/cache.ts";
import { segmentKey } from "../../src/smartRouter/cache.ts";
import type { Confidentiality } from "../../src/smartRouter/classifier.ts";

test("the key is a sha256 hex digest", () => {
  expect(segmentKey("m", "p", "s")).toMatch(/^[0-9a-f]{64}$/);
  expect(segmentKey("m", "p", "s")).toBe(segmentKey("m", "p", "s"));
});

test("the key differs by classifier model, policy and segment", () => {
  const base = segmentKey("m", "p", "s");
  expect(segmentKey("m2", "p", "s")).not.toBe(base);
  expect(segmentKey("m", "p2", "s")).not.toBe(base);
  expect(segmentKey("m", "p", "s2")).not.toBe(base);
});

test("moving text between fields does not collide", () => {
  expect(segmentKey("m", "ab", "c")).not.toBe(segmentKey("m", "a", "bc"));
  expect(segmentKey("ma", "b", "c")).not.toBe(segmentKey("m", "ab", "c"));
});

test("the cache holds both confidentiality verdicts", () => {
  const cache = new VerdictCache<Confidentiality>();
  cache.set("a", "public", 0);
  cache.set("b", "confidential", 0);
  expect(cache.get("a", 1)).toBe("public");
  expect(cache.get("b", 1)).toBe("confidential");
});
