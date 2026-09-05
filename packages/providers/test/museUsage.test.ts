/**
 * Muse's subscription usage payload, read into the two windows it describes.
 *
 * The field names are quoted from the shipped client's own serde metadata:
 * `SubscriptionUsageSnapshot { window, weekly }`, `SubscriptionWindowSnapshot
 * { used_percent, resets_at, window_duration_mins }`, `SubscriptionWeeklySnapshot
 * { used_percent, resets_at }`. Nothing here is a live capture — the fixtures
 * are built from that shape, which is what the parser is being held to.
 */

import { expect, test } from "bun:test";
import { parseMuseUsage } from "../src/muse/oauth.ts";

const NOW = 1_700_000_000_000;
/** Epoch **seconds**, which is what `resetAtOf` scales up from. */
const RESET = 1_700_000_600;

const payload = {
  window: { used_percent: 42, resets_at: RESET, window_duration_mins: 300 },
  weekly: { used_percent: 7, resets_at: RESET + 86_400 },
};

test("both windows are read, and the rolling one states its own length", () => {
  const report = parseMuseUsage(payload, NOW);

  expect(report?.windows).toEqual([
    {
      windowType: "fiveHour",
      used: 42,
      limit: 100,
      resetsAt: RESET * 1000,
      // Read from `window_duration_mins`, not assumed. A window filed under
      // `fiveHour` but actually running three would have its start inferred
      // two hours early, and the chart would show readings that never happened.
      windowMs: 300 * 60_000,
    },
    {
      windowType: "weekly",
      used: 7,
      limit: 100,
      resetsAt: (RESET + 86_400) * 1000,
      // The weekly snapshot states no duration; `weekly` already means seven
      // days, so saying nothing is correct rather than missing.
      windowMs: null,
    },
  ]);
});

test("a percentage becomes a value out of 100, so every consumer does one ratio", () => {
  // The router score, the quota filter and the console meter all divide
  // `used / limit`. A provider reporting a percentage that arrived as
  // `used: 42, limit: null` would be drawn as an unknown ceiling.
  const report = parseMuseUsage(payload, NOW);

  expect(report?.windows.every((w) => w.limit === 100)).toBe(true);
});

test("a duration Meta changes is followed rather than pinned to five hours", () => {
  // The whole reason the field is read. If the plans move to a three-hour
  // window, this keeps reporting the truth with no release.
  const report = parseMuseUsage(
    { window: { used_percent: 1, resets_at: RESET, window_duration_mins: 180 } },
    NOW,
  );

  expect(report?.windows[0]?.windowMs).toBe(180 * 60_000);
});

test("a window with no stated duration is reported without inventing one", () => {
  const report = parseMuseUsage({ window: { used_percent: 5, resets_at: RESET } }, NOW);

  expect(report?.windows[0]?.windowType).toBe("fiveHour");
  expect(report?.windows[0]?.windowMs).toBe(null);
});

test("one readable window survives the other being absent", () => {
  // A payload carrying only the weekly half is a real answer, not a broken one.
  const report = parseMuseUsage({ weekly: { used_percent: 90, resets_at: RESET } }, NOW);

  expect(report?.windows).toHaveLength(1);
  expect(report?.windows[0]?.windowType).toBe("weekly");
});

test("an unreadable payload is null, so the previous snapshot stands", () => {
  // An unreadable probe must leave the last good reading in place rather than
  // overwrite it with an empty one — missing data means unknown, never zero.
  expect(parseMuseUsage(null, NOW)).toBe(null);
  expect(parseMuseUsage("nope", NOW)).toBe(null);
  expect(parseMuseUsage({}, NOW)).toBe(null);
  // Present but empty: neither window says anything countable.
  expect(parseMuseUsage({ window: {}, weekly: {} }, NOW)).toBe(null);
});

test("a percentage past the ceiling is clamped rather than drawn past full", () => {
  const report = parseMuseUsage({ weekly: { used_percent: 140, resets_at: RESET } }, NOW);

  expect(report?.windows[0]?.used).toBe(100);
});
