import { describe, expect, test } from "bun:test";
import {
  formatChartTime,
  formatCount,
  formatDuration,
  formatMs,
  formatPercent,
  formatRelative,
  formatUsd,
  isDatedSpan,
  shortId,
} from "../../src/lib/format.ts";

describe("formatCount", () => {
  test("keeps small counts exact and compacts large ones", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(9_999)).toBe("9,999");
    expect(formatCount(12_400)).toBe("12.4k");
  });

  test("reports a missing number rather than NaN", () => {
    expect(formatCount(Number.NaN)).toBe("—");
  });
});

describe("formatUsd", () => {
  test("scales precision to the magnitude", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(18.021)).toBe("$18.02");
    expect(formatUsd(12_400)).toBe("$12.4k");
  });
});

describe("formatMs", () => {
  test("switches unit as the duration grows", () => {
    expect(formatMs(240)).toBe("240ms");
    expect(formatMs(1_500)).toBe("1.5s");
    expect(formatMs(180_000)).toBe("3m");
  });

  test("treats null and undefined as no reading", () => {
    expect(formatMs(null)).toBe("—");
    expect(formatMs(undefined)).toBe("—");
  });
});

describe("formatDuration and formatRelative", () => {
  test("picks the largest unit that fits", () => {
    expect(formatDuration(9_000)).toBe("9s");
    expect(formatDuration(720_000)).toBe("12m");
    expect(formatDuration(86_400_000 * 4)).toBe("4d");
  });

  test("names past and future", () => {
    const now = 1_800_000_000_000;
    expect(formatRelative(now - 720_000, now)).toBe("12m ago");
    expect(formatRelative(now + 10_800_000, now)).toBe("in 3h");
    expect(formatRelative(now - 1_000, now)).toBe("just now");
    expect(formatRelative(null, now)).toBe("—");
  });
});

test("formatPercent renders a fraction as a percentage", () => {
  expect(formatPercent(0.0912)).toBe("9.1%");
  expect(formatPercent(0, 0)).toBe("0%");
});

describe("formatChartTime", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const at = 1_800_000_000_000;

  // Asserted by shape rather than by literal: the output is local time, and a
  // suite pinned to one zone would pass in CI and lie to whoever ran it from
  // anywhere else.
  test("a span inside a day is a bare clock", () => {
    expect(formatChartTime(at, 10 * HOUR)).toMatch(/^\d{2}:\d{2}$/);
    expect(isDatedSpan(10 * HOUR)).toBe(false);
  });

  test("a span of a day or wider carries the date", () => {
    expect(formatChartTime(at, DAY)).toMatch(/^\d{2} \w{3} \d{2}:\d{2}$/);
    expect(formatChartTime(at, 14 * DAY)).toMatch(/^\d{2} \w{3} \d{2}:\d{2}$/);
    expect(isDatedSpan(DAY)).toBe(true);
  });

  // The reason the date is there at all: on a fortnight-wide axis the same
  // clock is reached fourteen times, and undated ticks name them identically.
  test("the same clock on two days reads differently once dated", () => {
    const nextDay = at + DAY;
    expect(formatChartTime(nextDay, 10 * HOUR)).toBe(formatChartTime(at, 10 * HOUR));
    expect(formatChartTime(nextDay, 14 * DAY)).not.toBe(formatChartTime(at, 14 * DAY));
  });

  test("a span that is not a number is not dated", () => {
    expect(formatChartTime(at, Number.NaN)).toMatch(/^\d{2}:\d{2}$/);
    expect(isDatedSpan(Number.NaN)).toBe(false);
    expect(isDatedSpan(Number.POSITIVE_INFINITY)).toBe(true);
  });
});

test("shortId truncates only when it must", () => {
  expect(shortId("abc")).toBe("abc");
  expect(shortId("0123456789abcdef")).toBe("01234567…");
});
