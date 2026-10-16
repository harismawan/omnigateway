import { expect, test } from "bun:test";
import {
  DIMENSIONS,
  limitConfigSchema,
  modelOverride,
  parseLimitConfig,
  WINDOWS,
} from "../src/catalog.ts";

test("the persisted vocabulary is the full matrix from the design", () => {
  // These names are the JSON keys of `api_keys.limits` in every row, so this
  // assertion is a storage contract rather than a spelling check. Adding a name
  // is free; renaming or removing one loses every row that used it.
  expect(DIMENSIONS).toEqual(["requests", "tokens", "spend", "concurrency"]);
  expect(WINDOWS).toEqual(["1m", "5h", "1w"]);
});

test("a full config round-trips through the schema", () => {
  const stored = {
    requests: { "1m": 60, "5h": 2000, "1w": null },
    tokens: { "1m": 100_000, "5h": null, "1w": 50_000_000 },
    spend: { "5h": null, "1w": 25.0 },
    concurrency: 8,
  };
  expect(parseLimitConfig(stored)).toEqual(stored);
});

test("an empty object is the unlimited key, and is what the migration backfills", () => {
  expect(parseLimitConfig({})).toEqual({});
});

test("an absent limit and an explicit null both mean unlimited", () => {
  // Nothing distinguishes them and nothing needs to: limits are per-key with no
  // inheritance, so there is no "inherit" for an absent key to mean.
  expect(parseLimitConfig({ requests: {} }).requests?.["1m"] ?? null).toBeNull();
  expect(parseLimitConfig({ requests: { "1m": null } }).requests?.["1m"] ?? null).toBeNull();
});

test("an unknown dimension is a parse failure, never a silent drop", () => {
  // `isRtkFilterId` may drop an unknown id on read because the cost is a gap in
  // history. Dropping an unknown limit key would read as "no limit" and fail
  // open on a control the operator explicitly set.
  expect(() => parseLimitConfig({ bandwidth: { "1m": 5 } })).toThrow();
  expect(limitConfigSchema.safeParse({ bandwidth: { "1m": 5 } }).success).toBe(false);
});

test("an unknown window is a parse failure, never a silent drop", () => {
  expect(() => parseLimitConfig({ requests: { "2m": 5 } })).toThrow();
  expect(() => parseLimitConfig({ tokens: { "1d": 5 } })).toThrow();
});

test("spend has no per-minute window", () => {
  // A per-minute dollar ceiling is a rate limit in costume; `requests` and
  // `tokens` already shape burst at that horizon.
  expect(() => parseLimitConfig({ spend: { "1m": 1 } })).toThrow();
  expect(parseLimitConfig({ spend: { "5h": 1.5 } }).spend?.["5h"]).toBe(1.5);
});

test("concurrency is a bare gauge, not a window map", () => {
  expect(parseLimitConfig({ concurrency: 8 }).concurrency).toBe(8);
  expect(() => parseLimitConfig({ concurrency: { "1m": 8 } })).toThrow();
});

test("a non-positive or fractional count is refused", () => {
  // Zero denies everything, which is not a ceiling an operator means to set;
  // they revoke the key instead.
  expect(() => parseLimitConfig({ requests: { "1m": 0 } })).toThrow();
  expect(() => parseLimitConfig({ requests: { "1m": -1 } })).toThrow();
  expect(() => parseLimitConfig({ requests: { "1m": 1.5 } })).toThrow();
  // Spend is dollars, so fractions are the point.
  expect(parseLimitConfig({ spend: { "1w": 25.5 } }).spend?.["1w"]).toBe(25.5);
  expect(() => parseLimitConfig({ spend: { "1w": 0 } })).toThrow();
});

test("a non-object is refused rather than read as unlimited", () => {
  expect(() => parseLimitConfig(null)).toThrow();
  expect(() => parseLimitConfig("60")).toThrow();
  expect(() => parseLimitConfig(60)).toThrow();
  expect(() => parseLimitConfig([])).toThrow();
});

/**
 * `.strict()` refuses `bogus` and `9m` but not this one: `JSON.parse` makes
 * `__proto__` an own property and zod 4.4.3 drops it silently rather than
 * refusing it. Left alone, a caller is told a ceiling was stored when the key
 * holds `{"requests":{}}` — an empty husk, and a success that changed nothing.
 *
 * Written against `JSON.parse` output rather than an object literal, because a
 * literal's `__proto__` never becomes an own property and the test would then
 * pass without exercising the check at all.
 */
test("a limits shape naming __proto__ is refused rather than silently emptied", () => {
  expect(() => parseLimitConfig(JSON.parse('{"__proto__":60}'))).toThrow(/__proto__/);
  expect(() => parseLimitConfig(JSON.parse('{"requests":{"__proto__":60}}'))).toThrow(/__proto__/);
  // The neighbouring rejections still work, so the guard has not replaced them.
  expect(() => parseLimitConfig(JSON.parse('{"bogus":60}'))).toThrow();
  expect(parseLimitConfig(JSON.parse('{"requests":{"1m":60}}'))).toEqual({
    requests: { "1m": 60 },
  });
});

test("per-model overrides nest under `models` in the key-wide shape", () => {
  const stored = {
    requests: { "1m": 600 },
    concurrency: 8,
    models: {
      opus: { requests: { "1m": 20 }, spend: { "5h": 5 }, concurrency: 2 },
      "llama3:8b": { tokens: { "1w": 2_000_000 } },
    },
  };
  expect(parseLimitConfig(stored)).toEqual(stored);
  // `models: {}` is no overrides, exactly as an absent member is.
  expect(parseLimitConfig({ models: {} })).toEqual({ models: {} });
});

test("an override holds the strict key-wide shape and no nesting", () => {
  expect(() => parseLimitConfig({ models: { opus: { bogus: 1 } } })).toThrow();
  expect(() => parseLimitConfig({ models: { opus: { requests: { "2m": 1 } } } })).toThrow();
  expect(() => parseLimitConfig({ models: { opus: { requests: { "1m": 0 } } } })).toThrow();
  expect(() => parseLimitConfig({ models: { opus: { spend: { "1m": 1 } } } })).toThrow();
  expect(() =>
    parseLimitConfig({
      models: { opus: { concurrency: 1, models: { haiku: { concurrency: 1 } } } },
    }),
  ).toThrow();
});

test("an empty override is refused, because it reads as a ceiling that is not there", () => {
  expect(() => parseLimitConfig({ models: { opus: {} } })).toThrow(/at least one/);
  expect(() =>
    parseLimitConfig({ models: { opus: { requests: { "1m": null }, concurrency: null } } }),
  ).toThrow(/at least one/);
  expect(() => parseLimitConfig({ models: { opus: { requests: {} } } })).toThrow(/at least one/);
  // A second override's emptiness is caught too, not only the first one's.
  expect(() =>
    parseLimitConfig({ models: { opus: { concurrency: 1 }, haiku: { spend: { "1w": null } } } }),
  ).toThrow(/at least one/);
  // One configured slot beside nulls is a ceiling.
  expect(
    parseLimitConfig({ models: { opus: { requests: { "1m": null, "1w": 5 } } } }).models?.opus,
  ).toEqual({ requests: { "1m": null, "1w": 5 } });
});

test("model names are bounded: 1..256 characters, at most 64 overrides", () => {
  expect(() => parseLimitConfig({ models: { "": { concurrency: 1 } } })).toThrow();
  expect(() => parseLimitConfig({ models: { ["m".repeat(257)]: { concurrency: 1 } } })).toThrow();
  expect(
    Object.keys(
      parseLimitConfig({ models: { ["m".repeat(256)]: { concurrency: 1 } } }).models ?? {},
    ),
  ).toHaveLength(1);

  const many = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`model-${i}`, { concurrency: 1 }]));
  expect(Object.keys(parseLimitConfig({ models: many(64) }).models ?? {})).toHaveLength(64);
  expect(() => parseLimitConfig({ models: many(65) })).toThrow(/64/);
});

test("a model named __proto__ is refused rather than silently dropped", () => {
  expect(() => parseLimitConfig(JSON.parse('{"models":{"__proto__":{"concurrency":1}}}'))).toThrow(
    /__proto__/,
  );
  expect(() =>
    parseLimitConfig(JSON.parse('{"models":{"opus":{"requests":{"__proto__":1}}}}')),
  ).toThrow(/__proto__/);
});

test("modelOverride answers own members only", () => {
  const limits = parseLimitConfig({ models: { opus: { concurrency: 2 } } });
  expect(modelOverride(limits, "opus")).toEqual({ concurrency: 2 });
  expect(modelOverride(limits, "haiku")).toBeUndefined();
  // A bare index would answer `Object.prototype.constructor` for these.
  expect(modelOverride(limits, "constructor")).toBeUndefined();
  expect(modelOverride(limits, "toString")).toBeUndefined();
  expect(modelOverride(limits, "hasOwnProperty")).toBeUndefined();
  expect(modelOverride({}, "opus")).toBeUndefined();
  expect(modelOverride({}, "constructor")).toBeUndefined();
  // A model that really is named `constructor` is still found.
  const odd = parseLimitConfig({ models: { constructor: { concurrency: 3 } } });
  expect(modelOverride(odd, "constructor")).toEqual({ concurrency: 3 });
});
