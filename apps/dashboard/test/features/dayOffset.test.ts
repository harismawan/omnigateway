/**
 * Day boundaries, cut on the gateway's offset rather than the browser's zone.
 *
 * The console bucketed every daily chart at the *viewer's* midnight while
 * `usage_daily` rows are cut at `OMNI_DAY_OFFSET_MINUTES`. On a single-node
 * install the two agree — the offset defaults to the host's own zone and the
 * operator is usually on that host — so the disagreement only appears where they
 * differ, which is every containerised deployment: the pod runs UTC and the
 * ConfigMap names an offset.
 *
 * These assert the arithmetic against fixed instants, which is the half that can
 * be checked without a timezone-dependent runner. `startOfDay(at, null)` is left
 * to the browser and deliberately not asserted here: its answer depends on the
 * zone the suite happens to run in, and pinning it would make this file pass or
 * fail on the machine rather than on the code.
 */

import { describe, expect, test } from "bun:test";
import { addDays, dayOfWeek, startOfDay, timeTicks } from "../../src/features/usage/shared.ts";

const DAY_MS = 86_400_000;
/** 2026-09-09T04:30:00Z — before Jakarta's midnight boundary, after UTC's. */
const AT = Date.UTC(2026, 8, 9, 4, 30);

describe("startOfDay with a gateway offset", () => {
  test("cuts UTC days at UTC midnight", () => {
    expect(startOfDay(AT, 0)).toBe(Date.UTC(2026, 8, 9));
  });

  test("cuts UTC+7 days seven hours earlier, so 04:30Z is still the 9th there", () => {
    // Jakarta is 11:30 on the 9th at this instant; its day began at 17:00Z on
    // the 8th.
    expect(startOfDay(AT, 420)).toBe(Date.UTC(2026, 8, 8, 17));
  });

  test("cuts a western offset the other way", () => {
    // US Pacific standard time is 21:30 on the *8th* at this instant, so the
    // instant belongs to the previous day and not the same one UTC reports.
    expect(startOfDay(AT, -480)).toBe(Date.UTC(2026, 8, 8, 8));
  });

  test("is idempotent, so re-bucketing a server day key does not move it", () => {
    // ActivityGrid re-keys buckets the gateway already cut. With the matching
    // offset that has to be identity, or a square lands on the wrong date.
    const start = startOfDay(AT, 420);
    expect(startOfDay(start, 420)).toBe(start);
  });

  test("puts an instant one millisecond before the boundary in the previous day", () => {
    const start = startOfDay(AT, 420);
    expect(startOfDay(start - 1, 420)).toBe(start - DAY_MS);
  });
});

describe("weekday and stepping in the same frame", () => {
  test("reads the weekday at the offset, not at UTC", () => {
    // 17:00Z on Saturday is already Sunday in Jakarta, and a grid that asked UTC
    // would file the square one column off from the day it counted.
    const saturdayEvening = Date.UTC(2026, 8, 12, 17);
    expect(dayOfWeek(saturdayEvening, 0)).toBe(6);
    expect(dayOfWeek(saturdayEvening, 420)).toBe(0);
  });

  test("steps whole days from a day start", () => {
    const start = startOfDay(AT, 420);
    expect(addDays(start, 1, 420)).toBe(start + DAY_MS);
    expect(addDays(start, -3, 420)).toBe(start - 3 * DAY_MS);
  });

  test("normalises before stepping, so a mid-day instant lands on a boundary", () => {
    expect(addDays(AT, 0, 420)).toBe(startOfDay(AT, 420));
  });
});

describe("timeTicks over days", () => {
  test("emits one tick per day, aligned to the offset", () => {
    const since = startOfDay(AT, 420);
    const ticks = timeTicks(since, since + 3 * DAY_MS, "day", 420);
    expect(ticks).toEqual([since, since + DAY_MS, since + 2 * DAY_MS, since + 3 * DAY_MS]);
  });

  test("covers the day a partial span starts in", () => {
    // A span starting mid-day still has to draw that day, or the first bucket
    // has no column to sit in.
    const ticks = timeTicks(AT, AT + DAY_MS, "day", 420);
    expect(ticks[0]).toBe(startOfDay(AT, 420));
  });
});
