import { expect, test } from "bun:test";
import type { Usage } from "@omni/ir";
import { priceOf } from "../../src/dispatch/price.ts";

const PRICES = {
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite5m: 6.25,
  cacheWrite1h: 10,
};

const usage = (u: Partial<Usage>): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...u,
});

/** Dollars per million tokens, so a million of anything costs its rate. */
const M = 1_000_000;

test("prices plain input and output at their own rates", () => {
  expect(priceOf(PRICES, usage({ inputTokens: M, outputTokens: M }))).toBeCloseTo(30, 10);
});

test("prices a cache read far below fresh input", () => {
  expect(priceOf(PRICES, usage({ cacheReadTokens: M }))).toBeCloseTo(0.5, 10);
});

test("prices each cache write at the rate for its ttl", () => {
  // The whole point of carrying the split: a 1h write costs 1.6x a 5m one.
  expect(
    priceOf(
      PRICES,
      usage({ cacheWriteTokens: 2 * M, cacheWrite5mTokens: M, cacheWrite1hTokens: M }),
    ),
  ).toBeCloseTo(16.25, 10);
});

test("does not double-count the aggregate alongside its own breakdown", () => {
  const split = priceOf(
    PRICES,
    usage({ cacheWriteTokens: M, cacheWrite5mTokens: M, cacheWrite1hTokens: 0 }),
  );
  expect(split).toBeCloseTo(6.25, 10);
});

test("treats an undifferentiated write as the default five-minute ttl", () => {
  // An upstream that reports only the aggregate still has to be priced, and
  // 5m is what a marker without an explicit ttl asks for.
  expect(priceOf(PRICES, usage({ cacheWriteTokens: M }))).toBeCloseTo(6.25, 10);
});

test("falls back to anthropic's published multipliers on a target with no write price", () => {
  // A target saved before write pricing existed carries input/output/cacheRead
  // only. Charging nothing for a write is the one answer that is certainly
  // wrong, so the documented 1.25x and 2x stand in.
  const legacy = { input: 5, output: 25, cacheRead: 0.5 };
  expect(priceOf(legacy, usage({ cacheWriteTokens: M, cacheWrite5mTokens: M }))).toBeCloseTo(
    6.25,
    10,
  );
  expect(priceOf(legacy, usage({ cacheWriteTokens: M, cacheWrite1hTokens: M }))).toBeCloseTo(
    10,
    10,
  );
});

test("honours a zero write price rather than falling back", () => {
  // A provider that bills no write premium says so with a zero, and zero is a
  // price, not a missing one.
  const free = { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 };
  expect(priceOf(free, usage({ cacheWriteTokens: M, cacheWrite5mTokens: M }))).toBe(0);
});

test("falls back to a tenth of input when a target names no cache read price", () => {
  expect(priceOf({ input: 5, output: 25 }, usage({ cacheReadTokens: M }))).toBeCloseTo(0.5, 10);
});
