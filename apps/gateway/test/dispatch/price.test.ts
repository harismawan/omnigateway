import { expect, test } from "bun:test";
import type { Usage } from "@omni/ir";
import { PROVIDER_DESCRIPTORS, type ProviderDescriptors } from "@omni/providers/descriptors";
import { entryOf } from "@omni/testkit";
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
  expect(priceOf(PRICES, usage({ inputTokens: M, outputTokens: M }), "anthropic")).toBeCloseTo(
    30,
    10,
  );
});

test("prices a cache read far below fresh input", () => {
  expect(priceOf(PRICES, usage({ cacheReadTokens: M }), "anthropic")).toBeCloseTo(0.5, 10);
});

test("prices each cache write at the rate for its ttl", () => {
  // The whole point of carrying the split: a 1h write costs 1.6x a 5m one.
  expect(
    priceOf(
      PRICES,
      usage({ cacheWriteTokens: 2 * M, cacheWrite5mTokens: M, cacheWrite1hTokens: M }),
      "anthropic",
    ),
  ).toBeCloseTo(16.25, 10);
});

test("does not double-count the aggregate alongside its own breakdown", () => {
  const split = priceOf(
    PRICES,
    usage({ cacheWriteTokens: M, cacheWrite5mTokens: M, cacheWrite1hTokens: 0 }),
    "anthropic",
  );
  expect(split).toBeCloseTo(6.25, 10);
});

test("treats an undifferentiated write as the default five-minute ttl", () => {
  // An upstream that reports only the aggregate still has to be priced, and
  // 5m is what a marker without an explicit ttl asks for.
  expect(priceOf(PRICES, usage({ cacheWriteTokens: M }), "anthropic")).toBeCloseTo(6.25, 10);
});

test("falls back to anthropic's published multipliers on a target with no write price", () => {
  // A target saved before write pricing existed carries input/output/cacheRead
  // only. Charging nothing for a write is the one answer that is certainly
  // wrong, so the documented 1.25x and 2x stand in.
  const legacy = { input: 5, output: 25, cacheRead: 0.5 };
  expect(
    priceOf(legacy, usage({ cacheWriteTokens: M, cacheWrite5mTokens: M }), "anthropic"),
  ).toBeCloseTo(6.25, 10);
  expect(
    priceOf(legacy, usage({ cacheWriteTokens: M, cacheWrite1hTokens: M }), "anthropic"),
  ).toBeCloseTo(10, 10);
});

test("honours a zero write price rather than falling back", () => {
  // A provider that bills no write premium says so with a zero, and zero is a
  // price, not a missing one.
  const free = { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 };
  expect(priceOf(free, usage({ cacheWriteTokens: M, cacheWrite5mTokens: M }), "anthropic")).toBe(0);
});

test("falls back to a tenth of input when a target names no cache read price", () => {
  expect(priceOf({ input: 5, output: 25 }, usage({ cacheReadTokens: M }), "anthropic")).toBeCloseTo(
    0.5,
    10,
  );
});

test("does not apply anthropic's write multipliers to another provider's target", () => {
  // A kimi or openai target saved before write pricing names no write price,
  // and its decoder can still report cache-creation tokens. Falling back to
  // 1.25x input there overcharges a provider whose catalog price is zero.
  const legacy = { input: 3, output: 15, cacheRead: 0.3 };
  expect(priceOf(legacy, usage({ cacheWriteTokens: M }), "kimi")).toBe(0);
  expect(priceOf(legacy, usage({ cacheWriteTokens: M }), "openai")).toBe(0);
  expect(priceOf(legacy, usage({ cacheWriteTokens: M }), "anthropic")).toBeCloseTo(3.75, 10);
});

test("a saved write price outranks the provider default either way", () => {
  const priced = { input: 3, output: 15, cacheWrite5m: 1, cacheWrite1h: 2 };
  expect(priceOf(priced, usage({ cacheWriteTokens: M }), "kimi")).toBeCloseTo(1, 10);
});

test("treats a partial ttl breakdown's shortfall as the other ttl, either way", () => {
  // The parts sum to the aggregate, so whichever side is missing is the
  // remainder. Deriving only one direction would price the other at zero.
  const only5m = priceOf(
    PRICES,
    usage({ cacheWriteTokens: 2 * M, cacheWrite5mTokens: M }),
    "anthropic",
  );
  expect(only5m).toBeCloseTo(6.25 + 10, 10);

  const only1h = priceOf(
    PRICES,
    usage({ cacheWriteTokens: 2 * M, cacheWrite1hTokens: M }),
    "anthropic",
  );
  expect(only1h).toBeCloseTo(6.25 + 10, 10);
});

test("prices against the registry it is handed, not the module-global one", () => {
  // The disagreement this parameter exists to close. `dispatch` threads
  // `deps.providers` into `resolveModel` and `rank`; for one round it did not
  // thread it here, so a provider present in the injected registry and absent
  // from the global one routed, dispatched, and then priced its cache writes at
  // zero — silently, with no throw and no log line.
  //
  // A legacy target: no explicit write prices, so the fallback multiplier is
  // what decides the bill. That is the only shape where this matters.
  const legacy = { input: 5, output: 25, cacheRead: 0.5 };
  const anthropic = entryOf(PROVIDER_DESCRIPTORS, "anthropic", "PROVIDER_DESCRIPTORS");
  const installed: ProviderDescriptors = {
    ...PROVIDER_DESCRIPTORS,
    "late-arrival": { ...anthropic, id: "late-arrival" },
  };

  // Against the real registry the provider is unknown, and the documented
  // fallback prices its writes at zero.
  expect(priceOf(legacy, usage({ cacheWriteTokens: M }), "late-arrival")).toBe(0);

  // Handed the registry that has it, the same request is billed Anthropic's
  // 1.25x write multiplier: 5 * 1.25 = 6.25 per million.
  expect(priceOf(legacy, usage({ cacheWriteTokens: M }), "late-arrival", installed)).toBeCloseTo(
    6.25,
    10,
  );
});

test("an explicit write price is used whatever registry is handed in", () => {
  // The positive control, and the reason the case above is narrow: a target
  // carrying its own `cacheWrite5m` never consults the descriptor at all, so
  // the registry cannot change its bill. Every target created since write
  // pricing existed is this shape.
  const ordinary: ProviderDescriptors = { ...PROVIDER_DESCRIPTORS };
  for (const providers of [undefined, ordinary, {} as ProviderDescriptors]) {
    expect(
      priceOf(
        PRICES,
        usage({ cacheWriteTokens: M, cacheWrite5mTokens: M }),
        "anthropic",
        providers,
      ),
    ).toBeCloseTo(6.25, 10);
  }
});
