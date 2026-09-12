import { describe, expect, test } from "bun:test";
import {
  dayKey,
  dayOf,
  formatRange,
  instantOf,
  monthDays,
  presetRange,
  rangeFor,
  timeOf,
  withinRange,
} from "../../src/features/logs/dateRange.ts";

/**
 * These run in whatever zone the machine is in, so every assertion is written
 * against values this module produced rather than against a hard-coded UTC
 * instant — a test that pinned one would pass in CI and fail on a laptop.
 */

describe("instantOf", () => {
  test("an upper bound covers the whole minute it names", () => {
    const start = instantOf("2026-09-12", "15:30", "start");
    const end = instantOf("2026-09-12", "15:30", "end");
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    // The controls are minute-granularity and the gateway's bounds are
    // inclusive, so `until = 15:30` has to admit a row at 15:30:42. Landing the
    // bound on 15:30:00.000 drops 59 seconds of traffic without saying so.
    expect((end ?? 0) - (start ?? 0)).toBe(59_999);
  });

  test("a lower bound is the first instant of its minute", () => {
    const at = instantOf("2026-09-12", "14:00", "start");
    expect(at).toBeDefined();
    expect(new Date(at ?? 0).getSeconds()).toBe(0);
    expect(new Date(at ?? 0).getMilliseconds()).toBe(0);
    expect(new Date(at ?? 0).getHours()).toBe(14);
  });

  test("an unparseable day is absent rather than NaN", () => {
    // `undefined` is how the caller spells "no bound"; NaN would reach the wire
    // as a filter nothing matches.
    expect(instantOf("", "14:00", "start")).toBeUndefined();
    expect(instantOf("2026-09-12", "", "end")).toBeUndefined();
  });

  test("a day and time round-trip through the instant they name", () => {
    const at = instantOf("2026-09-12", "15:30", "end");
    expect(at).toBeDefined();
    expect(dayOf(at ?? 0)).toBe("2026-09-12");
    expect(timeOf(at ?? 0)).toBe("15:30");
    // Stability matters because the control re-reads its own output every
    // render: a round-trip that drifted would walk the bound a minute per
    // keystroke.
    expect(instantOf(dayOf(at ?? 0), timeOf(at ?? 0), "end")).toBe(at ?? 0);
  });
});

describe("monthDays", () => {
  test("offsets the first day to its Monday-first column", () => {
    // September 2026 opens on a Tuesday, so one column is skipped.
    const { lead, days } = monthDays(2026, 8);
    expect(lead).toBe(1);
    expect(days).toHaveLength(30);
    expect(days[0]).toBe(1);
    expect(days.at(-1)).toBe(30);
  });

  test("a month opening on Monday skips no column", () => {
    // June 2026 opens on a Monday — the off-by-one the `(getDay() + 6) % 7`
    // shift exists for, and the one a Sunday-first grid gets wrong silently.
    expect(monthDays(2026, 5).lead).toBe(0);
  });

  test("a month opening on Sunday fills the row rather than starting one", () => {
    // November 2026 opens on a Sunday, the last column under this rotation.
    expect(monthDays(2026, 10).lead).toBe(6);
  });

  test("February is asked of the calendar, not a table", () => {
    expect(monthDays(2024, 1).days).toHaveLength(29);
    expect(monthDays(2026, 1).days).toHaveLength(28);
    expect(monthDays(2100, 1).days).toHaveLength(28);
  });
});

describe("rangeFor", () => {
  test("orders the pair whichever way it was clicked", () => {
    expect(rangeFor("2026-09-03", "2026-09-12")).toEqual({
      from: "2026-09-03",
      to: "2026-09-12",
    });
    // Clicking the end of an incident first is ordinary, so it is sorted rather
    // than refused.
    expect(rangeFor("2026-09-12", "2026-09-03")).toEqual({
      from: "2026-09-03",
      to: "2026-09-12",
    });
  });

  test("one day clicked twice is a one-day range", () => {
    expect(rangeFor("2026-09-12", "2026-09-12")).toEqual({
      from: "2026-09-12",
      to: "2026-09-12",
    });
  });

  test("ordering holds across a month and a year boundary", () => {
    // The comparison is a string compare, which is only correct because every
    // component is zero-padded. `dayKey` is the only thing that builds these.
    expect(rangeFor(dayKey(2027, 0, 3), dayKey(2026, 11, 28)).from).toBe("2026-12-28");
    expect(rangeFor(dayKey(2026, 8, 9), dayKey(2026, 8, 10)).to).toBe("2026-09-10");
  });
});

describe("withinRange", () => {
  test("is inclusive of both endpoints and false while half-chosen", () => {
    expect(withinRange("2026-09-03", "2026-09-03", "2026-09-12")).toBe(true);
    expect(withinRange("2026-09-12", "2026-09-03", "2026-09-12")).toBe(true);
    expect(withinRange("2026-09-07", "2026-09-03", "2026-09-12")).toBe(true);
    expect(withinRange("2026-09-13", "2026-09-03", "2026-09-12")).toBe(false);
    expect(withinRange("2026-09-03", "2026-09-03", undefined)).toBe(false);
  });
});

describe("presetRange", () => {
  test("a one-day preset is that whole local day", () => {
    const now = new Date(2026, 8, 12, 15, 30).getTime();
    const { since, until } = presetRange(1, now);
    expect(dayOf(since)).toBe("2026-09-12");
    expect(dayOf(until)).toBe("2026-09-12");
    expect(timeOf(since)).toBe("00:00");
    expect(new Date(until).getMilliseconds()).toBe(999);
  });

  test("a seven-day preset counts today as one of the seven", () => {
    const now = new Date(2026, 8, 12, 15, 30).getTime();
    // Six days back, not seven: "last 7 days" including today is what the label
    // claims, and an off-by-one here is a day of traffic nobody notices missing.
    expect(dayOf(presetRange(7, now).since)).toBe("2026-09-06");
    expect(dayOf(presetRange(30, now).since)).toBe("2026-08-14");
  });
});

describe("formatRange", () => {
  test("reads a half-open range honestly rather than as a blank half", () => {
    const at = instantOf("2026-09-03", "14:00", "start") ?? 0;
    const to = instantOf("2026-09-12", "15:30", "end") ?? 0;
    expect(formatRange(at, to)).toBe("Sep 3 14:00 - Sep 12 15:30");
    // Filters arrive from places other than this control, so one bound alone is
    // a state it has to render.
    expect(formatRange(at, undefined)).toBe("From Sep 3 14:00");
    expect(formatRange(undefined, to)).toBe("Until Sep 12 15:30");
    expect(formatRange(undefined, undefined)).toBe("Any time");
  });
});
