import { expect, test } from "bun:test";
import { DIMENSIONS, limitConfigSchema, parseLimitConfig, WINDOWS } from "../src/catalog.ts";

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
