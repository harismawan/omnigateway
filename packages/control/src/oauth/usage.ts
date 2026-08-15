import { GatewayError, type ProviderId } from "@omni/ir";
import type { WindowType } from "@omni/store";
import type { UsageWindowReport } from "./types.ts";

/**
 * Shared readers for provider usage payloads.
 *
 * None of these endpoints is documented, and their field names differ between
 * providers and drift between releases. The parsers are therefore written to
 * accept a small family of spellings and to return null rather than throw when
 * a payload does not contain what was expected: an unreadable probe must leave
 * the previous snapshot standing, not take the poller down.
 *
 * Percentages are normalized to `used` out of `limit: 100` so that every
 * consumer — router score, filter, console meter — does the same ratio.
 */

/**
 * Whether a usage response body is worth parsing.
 *
 * A 429 is singled out and thrown rather than swallowed. These quota endpoints
 * are rate-limited separately from inference — polling one too often answers
 * 429 while chat with the same token keeps working — so the poller needs to
 * hear about it and back off, not treat it as one more empty reading.
 *
 * Every other non-2xx returns false: the endpoints are undocumented, and a 404
 * or a 401 from one is at least as likely to mean it moved as to mean anything
 * about the credential.
 */
export function usageReadable(status: number, provider: ProviderId): boolean {
  if (status === 429) {
    throw new GatewayError("RATE_LIMIT", `${provider} usage endpoint is rate limited`);
  }
  return status >= 200 && status < 300;
}

export function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * First key that holds a finite number.
 *
 * Numeric strings count: Kimi reports `{"limit": "100", "used": "92"}`, and
 * rejecting those would read a fully described account as unknown.
 */
export function numberOf(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/** First key that holds a record. */
export function nestedOf(
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | null {
  for (const key of keys) {
    const nested = recordOf(record[key]);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * Reads an absolute timestamp.
 *
 * Providers express resets three ways: an ISO string, an epoch in seconds or
 * milliseconds, and a relative "seconds from now". Seconds and milliseconds are
 * told apart by magnitude — anything below 1e12 as an absolute epoch would be
 * 1970, which no provider means.
 */
export function resetAtOf(
  record: Record<string, unknown>,
  keys: {
    absolute: readonly string[];
    relativeSeconds?: readonly string[];
  },
  now: number,
): number | null {
  for (const key of keys.absolute) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }

  for (const key of keys.relativeSeconds ?? []) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return now + Math.round(value * 1000);
    }
  }

  return null;
}

const USED_KEYS = ["used", "used_units", "usage", "consumed"] as const;
const LIMIT_KEYS = ["limit", "limit_units", "total", "quota", "allowed"] as const;
const PERCENT_KEYS = [
  "utilization",
  "used_percent",
  "usedPercent",
  "percent_used",
  "percentUsed",
  "percent",
] as const;
const RESET_ABSOLUTE_KEYS = [
  "resets_at",
  "resetsAt",
  "reset_at",
  "resetAt",
  "resetTime",
  "reset_time",
  "resets_at_epoch",
  "reset",
] as const;
const RESET_RELATIVE_KEYS = [
  "resets_in_seconds",
  "resetsInSeconds",
  "reset_after_seconds",
  "resetAfterSeconds",
  "seconds_until_reset",
  "resets_in",
] as const;

/**
 * Turns one provider window object into a report.
 *
 * An explicit used/limit pair wins over a percentage, because it is the
 * provider's own arithmetic. A percentage alone becomes a value out of 100.
 * A window with neither is not a window we can draw, and returns null.
 *
 * `windowMs` is passed in rather than read here because only the caller knows
 * where its provider states a duration — the key differs per payload, and most
 * providers state none. It defaults to null so those callers say nothing.
 */
export function windowFrom(
  value: unknown,
  windowType: WindowType,
  now: number,
  windowMs: number | null = null,
): UsageWindowReport | null {
  const record = recordOf(value);
  if (record === null) return null;

  const resetsAt = resetAtOf(
    record,
    { absolute: RESET_ABSOLUTE_KEYS, relativeSeconds: RESET_RELATIVE_KEYS },
    now,
  );

  const used = numberOf(record, USED_KEYS);
  const limit = numberOf(record, LIMIT_KEYS);
  if (used !== null) {
    return { windowType, used: Math.max(0, used), limit, resetsAt, windowMs };
  }

  // Some payloads report only what is left. Remaining plus a ceiling is the
  // same fact stated backwards.
  const remaining = numberOf(record, ["remaining", "remaining_units", "left"]);
  if (remaining !== null && limit !== null) {
    return { windowType, used: Math.max(0, limit - remaining), limit, resetsAt, windowMs };
  }

  const percent = numberOf(record, PERCENT_KEYS);
  if (percent !== null) {
    return {
      windowType,
      used: Math.max(0, Math.min(100, percent)),
      limit: 100,
      resetsAt,
      windowMs,
    };
  }

  return null;
}

/** Drops unreadable windows; a report with nothing left is no report at all. */
export function reportFrom(
  windows: ReadonlyArray<UsageWindowReport | null>,
): { windows: UsageWindowReport[] } | null {
  const kept = windows.filter((w): w is UsageWindowReport => w !== null);
  return kept.length === 0 ? null : { windows: kept };
}
