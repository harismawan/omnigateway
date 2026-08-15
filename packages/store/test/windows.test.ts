import { expect, test } from "bun:test";
import {
  durationFor,
  type QuotaBurnReading,
  quotaVerdict,
  SAME_WINDOW_TOLERANCE_MS,
  sameWindow,
  WINDOW_DURATION_MS,
} from "../src/types.ts";

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

test("a reset time that drifted by a fraction of a second is the same window", () => {
  // The reproduction case: a provider that reports a whole-second countdown has
  // its absolute reset derived as `now + seconds * 1000`, and `now` moves a poll
  // interval between probes. Nothing rolled over; the arithmetic jittered.
  expect(sameWindow(1_700_000_000_000, 1_700_000_000_137)).toBe(true);
  expect(sameWindow(1_700_000_000_137, 1_700_000_000_000)).toBe(true);
  expect(sameWindow(1_700_000_000_000, 1_700_000_002_400)).toBe(true);
});

test("a reset time that moved by a whole window is a different window", () => {
  const at = 1_700_000_000_000;
  expect(sameWindow(at, at + WINDOW_DURATION_MS.fiveHour)).toBe(false);
  expect(sameWindow(at, at + WINDOW_DURATION_MS.weekly)).toBe(false);
});

test("the tolerance sits far above the jitter and far below the shortest window", () => {
  // Both margins are what make the threshold unambiguous rather than tuned: a
  // rollover cannot hide under it, and jitter cannot escape it.
  expect(SAME_WINDOW_TOLERANCE_MS).toBeGreaterThanOrEqual(10_000);
  expect(SAME_WINDOW_TOLERANCE_MS * 10).toBeLessThan(WINDOW_DURATION_MS.fiveHour);
  expect(sameWindow(0, SAME_WINDOW_TOLERANCE_MS)).toBe(true);
  expect(sameWindow(0, SAME_WINDOW_TOLERANCE_MS + 1)).toBe(false);
});

test("an unstated reset matches only another unstated reset", () => {
  // Null is not near anything: a provider that started or stopped naming a reset
  // said something new, and that is a reading worth keeping.
  expect(sameWindow(null, null)).toBe(true);
  expect(sameWindow(null, 1_700_000_000_000)).toBe(false);
  expect(sameWindow(1_700_000_000_000, null)).toBe(false);
});

const reading = (patch: Partial<QuotaBurnReading> = {}): QuotaBurnReading => ({
  ratePerHour: 10,
  exhaustsAt: 1_700_000_000_000,
  survives: true,
  stale: false,
  ...patch,
});

const observed = { observedAt: 1_699_000_000_000, limit: 100 };

test("a window that outlives its reset is ok", () => {
  expect(quotaVerdict(observed, reading())).toBe("ok");
});

test("a window that runs out first is empty", () => {
  expect(quotaVerdict(observed, reading({ survives: false }))).toBe("empty");
});

test("no ceiling is unknown, never a claim that the window lasts", () => {
  // `survives` is true by construction whenever there is no `exhaustsAt`, which
  // includes having no limit at all. Reading it directly turns "the provider
  // reported no ceiling" into "you will not run out".
  expect(quotaVerdict({ ...observed, limit: null }, reading({ exhaustsAt: null }))).toBe("unknown");
});

test("no inferable rate is unknown, never a claim that the window lasts", () => {
  expect(quotaVerdict(observed, reading({ ratePerHour: null, exhaustsAt: null }))).toBe("unknown");
});

test("a never-observed window is unknown and an aged one is stale", () => {
  // Two different things to go and fix: nothing has ever been read, versus a
  // reading that has stopped being refreshed.
  const suppressed = reading({ ratePerHour: null, exhaustsAt: null, survives: null, stale: true });
  expect(quotaVerdict({ ...observed, observedAt: 0 }, suppressed)).toBe("unknown");
  expect(quotaVerdict(observed, suppressed)).toBe("stale");
});

test("a missing estimate is unknown", () => {
  expect(quotaVerdict(observed, undefined)).toBe("unknown");
});
