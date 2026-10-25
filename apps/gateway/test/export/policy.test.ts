import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "@omni/store";
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  parseRetryAfter,
  retryDelay,
} from "../../src/export/backoff.ts";
import { effectivePosition, GAP_MARGIN_MS, gapReason, SETTLE_MS } from "../../src/export/gap.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 25);
const settings = (over: Partial<typeof DEFAULT_SETTINGS> = {}) => ({
  ...DEFAULT_SETTINGS,
  logRetentionDays: 30,
  logRetentionLoweredAt: 0,
  ...over,
});
const view = (over: Partial<Parameters<typeof gapReason>[0]> = {}) => ({
  cursorAt: NOW - DAY,
  caughtUpThrough: 0,
  seenRetentionLoweredAt: 0,
  ...over,
});

test("the design's constants", () => {
  expect(SETTLE_MS).toBe(10_000);
  expect(GAP_MARGIN_MS).toBe(DAY);
  expect(BACKOFF_MIN_MS).toBe(1_000);
  expect(BACKOFF_MAX_MS).toBe(5 * 60 * 1000);
});

test("the effective position is the later of the cursor and the caught-up bound", () => {
  expect(effectivePosition({ cursorAt: 5, caughtUpThrough: 9 })).toBe(9);
  expect(effectivePosition({ cursorAt: 12, caughtUpThrough: 9 })).toBe(12);
});

test("a destination within a day of the prune horizon is flagged; one well inside is not", () => {
  // H = now - 30 d; the flag line is H + 24 h = now - 29 d.
  const line = NOW - 29 * DAY;
  expect(gapReason(view({ cursorAt: line - 1 }), settings(), NOW, 0)).toBe("lag");
  expect(gapReason(view({ cursorAt: line }), settings(), NOW, 0)).toBeNull();
  expect(gapReason(view({ cursorAt: NOW - DAY }), settings(), NOW, 0)).toBeNull();
});

test("an idle caught-up destination is judged by its caught-up bound, not its old cursor", () => {
  const idle = view({ cursorAt: NOW - 100 * DAY, caughtUpThrough: NOW - SETTLE_MS });
  expect(gapReason(idle, settings(), NOW, 0)).toBeNull();
});

test("a retention shortening newer than the last one seen flags, whatever the position", () => {
  const fresh = view({ cursorAt: NOW, caughtUpThrough: NOW, seenRetentionLoweredAt: 100 });
  expect(gapReason(fresh, settings({ logRetentionLoweredAt: 101 }), NOW, 0)).toBe(
    "retention-lowered",
  );
  expect(gapReason(fresh, settings({ logRetentionLoweredAt: 100 }), NOW, 0)).toBeNull();
});

test("a shortening before the destination existed is not one it could have lost rows to", () => {
  const fresh = view({ cursorAt: NOW, seenRetentionLoweredAt: 0 });
  const created = NOW - 1_000;
  expect(gapReason(fresh, settings({ logRetentionLoweredAt: created - 1 }), NOW, created)).toBe(
    null,
  );
  expect(gapReason(fresh, settings({ logRetentionLoweredAt: created + 1 }), NOW, created)).toBe(
    "retention-lowered",
  );
});

test("backoff starts at 1 s, doubles, caps at 5 min, and is jittered downward only", () => {
  const top = () => 1 - Number.EPSILON;
  const bottom = () => 0;
  expect(retryDelay(1, null, top)).toBe(1_000);
  expect(retryDelay(2, null, top)).toBe(2_000);
  expect(retryDelay(3, null, top)).toBe(4_000);
  expect(retryDelay(30, null, top)).toBe(BACKOFF_MAX_MS);
  expect(retryDelay(1_000, null, top)).toBe(BACKOFF_MAX_MS);
  expect(retryDelay(3, null, bottom)).toBe(2_000);
});

test("Retry-After is honoured up to 5 min and never shortens the backoff", () => {
  const mid = () => 0.5;
  expect(retryDelay(1, 120_000, mid)).toBe(120_000);
  expect(retryDelay(1, 3_600_000, mid)).toBe(BACKOFF_MAX_MS);
  expect(retryDelay(10, 1_000, mid)).toBeGreaterThan(1_000);
});

test("Retry-After reads seconds or an HTTP date, and nothing else", () => {
  expect(parseRetryAfter("120", NOW)).toBe(120_000);
  expect(parseRetryAfter(new Date(NOW + 30_000).toUTCString(), NOW)).toBe(30_000);
  expect(parseRetryAfter(new Date(NOW - 30_000).toUTCString(), NOW)).toBe(0);
  expect(parseRetryAfter(null, NOW)).toBeNull();
  expect(parseRetryAfter("soon", NOW)).toBeNull();
  expect(parseRetryAfter("-5", NOW)).toBeNull();
});
