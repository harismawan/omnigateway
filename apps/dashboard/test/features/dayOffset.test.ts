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
 * The null arm — "the gateway did not say, use the browser's zone" — is asserted
 * too, under a pinned `TZ`. An earlier draft of this file declined to, on the
 * grounds that its answer depends on the runner's zone. That reasoning was
 * wrong, and expensively so: `bun test` forces `TZ=UTC`, where
 * `setHours(0,0,0,0)` *is* UTC midnight and `getDay()` *is* `getUTCDay()`, so
 * the fallback and the offset path are indistinguishable by construction and
 * three mutations to the null arm survived the whole suite. The zone is
 * pinnable; not pinning it is what made the arm untestable.
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

describe("the browser-zone fallback, when the gateway did not say", () => {
  /**
   * Runs `fn` with `TZ` pinned, so the arm is asserted rather than assumed.
   *
   * Restores by deleting rather than assigning `undefined`: under
   * `exactOptionalPropertyTypes` those are different, and an env var literally
   * set to the string "undefined" is the kind of leak that reads as a zone.
   */
  const inZone = (tz: string, fn: () => void): void => {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try {
      fn();
    } finally {
      // Back to UTC when nothing was set, never deleted. `bun test` establishes
      // `TZ=UTC` for the whole run without necessarily putting it in `env`, so
      // deleting leaves the process on the *host's* zone — and every other file
      // sharing this process that formats a local time then fails. Three
      // `KeysBoard` expiry tests did exactly that.
      process.env.TZ = prev ?? "UTC";
    }
  };

  test("cuts the day at the browser's own midnight", () => {
    // UTC+7: 04:30Z is 11:30 local on the 9th, whose local midnight is 17:00Z
    // on the 8th. Under the runner's default UTC this would be 00:00Z on the
    // 9th, so the two frames disagree here and the assertion has teeth.
    inZone("Asia/Jakarta", () => {
      expect(startOfDay(AT, null)).toBe(Date.UTC(2026, 8, 8, 17));
    });
  });

  test("reads the weekday at the offset, not at the browser's zone", () => {
    // The offset arm, asserted where the two can differ. Under the runner's
    // default UTC, `getUTCDay()` and `getDay()` return the same number for
    // every input, so swapping one for the other survived the whole suite.
    inZone("Asia/Jakarta", () => {
      // 17:00Z Saturday: still Saturday at UTC, already Sunday in Jakarta.
      expect(dayOfWeek(Date.UTC(2026, 8, 12, 17), 0)).toBe(6);
    });
  });

  test("reads the weekday in the browser's zone", () => {
    inZone("Asia/Jakarta", () => {
      // 17:00Z Saturday is already Sunday in Jakarta.
      expect(dayOfWeek(Date.UTC(2026, 8, 12, 17), null)).toBe(0);
    });
  });

  test("steps through the calendar, so a DST transition stays one day", () => {
    // New York springs forward 2026-03-08: that local day is 23 hours long, so
    // adding DAY_MS would land at 01:00 on the 9th and every later tick would
    // carry the error. This arm exists for exactly this instant.
    inZone("America/New_York", () => {
      const beforeDst = startOfDay(Date.UTC(2026, 2, 7, 17), null);
      const next = addDays(beforeDst, 1, null);
      expect(next - beforeDst).toBe(DAY_MS);
      const acrossDst = addDays(next, 1, null);
      expect(acrossDst - next).toBe(23 * 60 * 60 * 1000);
      expect(new Date(acrossDst).getHours()).toBe(0);
    });
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

describe("the tick axis and the server's bucket keys", () => {
  /**
   * The two have to be cut in the same frame or nothing joins.
   *
   * `timeTicks` gained its offset parameter and no panel passed it, so the axis
   * stayed on browser midnight while `since` and the server's `usage_daily`
   * keys moved to the gateway's. Every daily series then rendered flat zero
   * over real traffic, and the activity grid — which had been rewired — drew
   * the same days as busy. Measured before the fix: 91 ticks, 91 buckets, 0
   * joined.
   *
   * This asserts the join rather than the argument, so it survives the panels
   * being refactored and fails again if any of them drops the offset.
   */
  test("join, for the offset the gateway reports", () => {
    const offset = 420;
    const since = startOfDay(AT, offset);
    const until = since + 6 * DAY_MS;

    // What the server would key these days as: `usage_daily.day` is its own
    // `startOfDay` at the configured offset.
    const serverKeys = new Set<number>();
    for (let at = since; at <= until; at += DAY_MS) serverKeys.add(startOfDay(at, offset));

    const ticks = timeTicks(since, until, "day", offset);
    expect(ticks).toHaveLength(7);
    expect(ticks.filter((at) => serverKeys.has(at))).toHaveLength(7);
  });

  test("do not join when the axis is left on the browser's zone", () => {
    // The bug, stated as a fact rather than a caveat: passing no offset is not
    // a harmless default here, it is a different frame. Asserted under a fixed
    // TZ so the runner's own zone cannot make the two agree by accident.
    const prev = process.env.TZ;
    process.env.TZ = "Asia/Jakarta";
    try {
      const offset = 0;
      const since = startOfDay(AT, offset);
      const until = since + 6 * DAY_MS;
      const serverKeys = new Set([...Array(7).keys()].map((i) => since + i * DAY_MS));

      const browserCut = timeTicks(since, until, "day", null);
      expect(browserCut.filter((at) => serverKeys.has(at))).toHaveLength(0);
    } finally {
      // Back to UTC when nothing was set, never deleted. `bun test` establishes
      // `TZ=UTC` for the whole run without necessarily putting it in `env`, so
      // deleting leaves the process on the *host's* zone — and every other file
      // sharing this process that formats a local time then fails. Three
      // `KeysBoard` expiry tests did exactly that.
      process.env.TZ = prev ?? "UTC";
    }
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
