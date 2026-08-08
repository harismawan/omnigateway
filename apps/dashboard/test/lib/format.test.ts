import { describe, expect, test } from "bun:test";
import {
  formatCount,
  formatDuration,
  formatMs,
  formatPercent,
  formatRelative,
  formatUsd,
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

test("shortId truncates only when it must", () => {
  expect(shortId("abc")).toBe("abc");
  expect(shortId("0123456789abcdef")).toBe("01234567…");
});
