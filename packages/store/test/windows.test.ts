import { expect, test } from "bun:test";
import { durationFor, WINDOW_DURATION_MS } from "../src/types.ts";

test("a provider-reported duration outranks the nominal one", () => {
  // Codex buckets a three-hour window under the `fiveHour` name. Inferring the
  // window start from the nominal five hours would place it two hours too
  // early and understate everything measured against it.
  expect(durationFor("fiveHour", 3 * 60 * 60 * 1000)).toBe(3 * 60 * 60 * 1000);
  expect(durationFor("weekly", 24 * 60 * 60 * 1000)).toBe(24 * 60 * 60 * 1000);
});

test("a window with no reported duration falls back to the nominal one", () => {
  expect(durationFor("fiveHour", null)).toBe(WINDOW_DURATION_MS.fiveHour);
  expect(durationFor("daily", null)).toBe(WINDOW_DURATION_MS.daily);
  expect(durationFor("weekly", null)).toBe(WINDOW_DURATION_MS.weekly);
});

test("a non-positive reported duration is not believed", () => {
  // A zero-length window is not a window; dividing an elapsed span by it would
  // manufacture an infinite rate out of a bad reading.
  expect(durationFor("fiveHour", 0)).toBe(WINDOW_DURATION_MS.fiveHour);
  expect(durationFor("fiveHour", -1)).toBe(WINDOW_DURATION_MS.fiveHour);
});

test("the nominal durations are the windows the store names", () => {
  expect(WINDOW_DURATION_MS).toEqual({
    fiveHour: 5 * 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
  });
});
