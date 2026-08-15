// The `/types` subpath is a leaf: domain types plus the pure predicates over
// them. `sameWindow` is imported rather than reimplemented because the store
// dedups on it, and a chart that disagreed with storage about what a window is
// would be a worse bug than either being wrong alone.
import { durationFor, sameWindow } from "@omni/store/types";
import type {
  BurnEstimate,
  CredentialHealth,
  DisabledReason,
  QuotaSample,
  QuotaWindow,
  RequestLog,
} from "../api/types.ts";
import { formatDuration } from "./format.ts";

/**
 * Derivations the gateway does not compute for us. The control API exposes raw
 * rows — request logs, breaker health, quota windows — and every readout on the
 * console is a pure function of those, so nothing here caches or fetches.
 */

export type Vitals = {
  requests: number;
  errors: number;
  errorRate: number;
  /** Requests per minute across the window, not an instantaneous rate. */
  ratePerMin: number;
  ttftP50: number | null;
  ttftP95: number | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? null;
}

/** A request the gateway is still serving. Its zeros are placeholders. */
export function isPending(log: RequestLog): boolean {
  return log.state === "pending";
}

/**
 * Drops rows for requests still in flight.
 *
 * Every derived figure runs through this first. A pending row reports no
 * tokens, no cost and no latency, so counting one as a request would pull each
 * rate toward zero exactly when traffic picks up — the health strip would dip
 * for being busy.
 */
export function completed(logs: readonly RequestLog[]): RequestLog[] {
  return logs.filter((log) => !isPending(log));
}

/** A log row counts as an error on any non-2xx status the gateway recorded. */
export function isError(log: RequestLog): boolean {
  // A request in flight has not failed yet. Its status is a placeholder zero,
  // so this would read as success anyway; saying so makes that intent.
  if (isPending(log)) return false;
  return log.status >= 400 || log.errorCode !== null;
}

export type LampState = "ok" | "warn" | "down" | "idle" | "live";

export const LAMP_GLYPH: Record<LampState, string> = {
  ok: "●",
  warn: "◐",
  down: "○",
  idle: "·",
  // Live shares the healthy glyph, but pulses until the request completes.
  live: "●",
};

/**
 * How a log row reads in a lamp. Shared by the log and the activity tail, so
 * one request looks the same on both screens.
 *
 * The label is the lamp's accessible name, and for a live row it is the whole
 * signal: the animation says nothing to a screen reader.
 */
export function lampState(log: RequestLog): LampState {
  if (isPending(log)) return "live";
  return isError(log) ? "down" : "ok";
}

export function lampLabel(log: RequestLog): string {
  if (isPending(log)) return "in flight";
  return isError(log) ? `failed with ${log.status}` : "succeeded";
}

export function summarize(all: readonly RequestLog[], windowMs: number): Vitals {
  const logs = completed(all);
  const ttfts: number[] = [];
  let errors = 0;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  for (const log of logs) {
    if (isError(log)) errors += 1;
    if (log.ttftMs !== null && Number.isFinite(log.ttftMs)) ttfts.push(log.ttftMs);
    costUsd += log.costUsd;
    inputTokens += log.inputTokens;
    outputTokens += log.outputTokens;
    cacheReadTokens += log.cacheReadTokens;
    cacheWriteTokens += log.cacheWriteTokens;
  }

  const minutes = windowMs / 60_000;
  return {
    requests: logs.length,
    errors,
    errorRate: logs.length === 0 ? 0 : errors / logs.length,
    ratePerMin: minutes <= 0 ? 0 : logs.length / minutes,
    ttftP50: percentile(ttfts, 0.5),
    ttftP95: percentile(ttfts, 0.95),
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export type Bucket = {
  at: number;
  total: number;
  errors: number;
  costUsd: number;
  tokens: number;
  /** Median first-token latency inside the bucket, or null if nothing streamed. */
  ttftMs: number | null;
};

/**
 * Buckets logs into a fixed number of equal slices ending at `now`, oldest
 * first, so a sparkline always has the same number of points and a quiet
 * gateway draws a flat line rather than an empty box.
 */
export function bucketLogs(
  all: readonly RequestLog[],
  options: { now: number; spanMs: number; count: number },
): Bucket[] {
  const logs = completed(all);
  const { now, spanMs, count } = options;
  const width = spanMs / count;
  const start = now - spanMs;
  const buckets: Bucket[] = Array.from({ length: count }, (_, i) => ({
    at: start + i * width,
    total: 0,
    errors: 0,
    costUsd: 0,
    tokens: 0,
    ttftMs: null,
  }));
  const latencies: number[][] = Array.from({ length: count }, () => []);

  for (const log of logs) {
    if (log.at < start || log.at > now) continue;
    const index = Math.min(count - 1, Math.floor((log.at - start) / width));
    const bucket = buckets[index];
    if (bucket === undefined) continue;
    bucket.total += 1;
    bucket.costUsd += log.costUsd;
    bucket.tokens +=
      log.inputTokens + log.outputTokens + log.cacheReadTokens + log.cacheWriteTokens;
    if (isError(log)) bucket.errors += 1;
    if (log.ttftMs !== null && Number.isFinite(log.ttftMs)) latencies[index]?.push(log.ttftMs);
  }

  for (const [index, bucket] of buckets.entries()) {
    bucket.ttftMs = percentile(latencies[index] ?? [], 0.5);
  }
  return buckets;
}

/** What the operator has to do, not what the gateway observed. */
const RECONNECT_NOTE: Record<"tokenRejected" | "expiredNoRefresh", string> = {
  tokenRejected: "reconnect needed — provider rejected the refresh token",
  expiredNoRefresh: "reconnect needed — token expired with nothing to refresh from",
};

export type CredentialStatus = {
  state: LampState;
  /** Short reason, shown next to the lamp. Empty when nothing is wrong. */
  note: string;
  /** Slowest-moving EWMA across this credential's models. */
  ttftMs: number | null;
  lastUsedAt: number | null;
  consecutiveFailures: number;
};

/**
 * Rolls a credential's per-model health rows into one lamp.
 *
 * The worst row wins: one open breaker on one model is a fault the operator
 * needs to see, even if the credential's other models are fine.
 */
export function credentialStatus(
  rows: readonly CredentialHealth[],
  now: number,
  enabled: boolean,
  disabledReason: DisabledReason | null = null,
): CredentialStatus {
  if (!enabled) {
    // A credential the provider repudiated is not the same as one the operator
    // switched off: it needs a reconnect, and nothing routes until it gets one.
    // Showing both as a quiet "disabled" is how a dead account goes unnoticed
    // until requests start failing.
    const needsReconnect =
      disabledReason === "tokenRejected" || disabledReason === "expiredNoRefresh";
    return {
      state: needsReconnect ? "down" : "idle",
      note: needsReconnect ? RECONNECT_NOTE[disabledReason] : "disabled",
      ttftMs: null,
      lastUsedAt: null,
      consecutiveFailures: 0,
    };
  }
  if (rows.length === 0) {
    return {
      state: "idle",
      note: "unused",
      ttftMs: null,
      lastUsedAt: null,
      consecutiveFailures: 0,
    };
  }

  let state: LampState = "ok";
  let note = "";
  let ttftMs: number | null = null;
  let lastUsedAt: number | null = null;
  let consecutiveFailures = 0;

  for (const row of rows) {
    if (row.ewmaTtftMs !== null)
      ttftMs = ttftMs === null ? row.ewmaTtftMs : Math.max(ttftMs, row.ewmaTtftMs);
    if (row.lastUsedAt !== null) {
      lastUsedAt = lastUsedAt === null ? row.lastUsedAt : Math.max(lastUsedAt, row.lastUsedAt);
    }
    consecutiveFailures = Math.max(consecutiveFailures, row.consecutiveFailures);

    if (row.breakerState === "open") {
      state = "down";
      note = "breaker open";
      continue;
    }
    if (row.rateLimitedUntil !== null && row.rateLimitedUntil > now && state !== "down") {
      state = "warn";
      note = "rate limited";
      continue;
    }
    if (row.breakerState === "halfOpen" && state === "ok") {
      state = "warn";
      note = "probing";
    }
  }

  return { state, note, ttftMs, lastUsedAt, consecutiveFailures };
}

export const WINDOW_LABEL: Record<QuotaWindow["windowType"], string> = {
  fiveHour: "5h",
  daily: "24h",
  weekly: "7d",
};

export type QuotaUse = { window: QuotaWindow; fraction: number };

/**
 * How old a reading may be before the console stops presenting it as current.
 *
 * Three poll intervals: one missed poll is a blip, three in a row means the
 * probe is not getting through and the bar is describing the past.
 */
export function quotaStaleAfterMs(pollIntervalMs: number): number {
  return Math.max(pollIntervalMs, 60_000) * 3;
}

/** True once a snapshot is old enough that it should be labelled, not trusted. */
export function isQuotaStale(window: QuotaWindow, now: number, pollIntervalMs: number): boolean {
  // Zero means the row predates snapshots, or polling has never succeeded.
  if (window.observedAt <= 0) return true;
  return now - window.observedAt > quotaStaleAfterMs(pollIntervalMs);
}

/** The estimate for one window out of a credential's entries, if it has one. */
export function burnOf(
  rows: readonly BurnEstimate[],
  windowType: QuotaWindow["windowType"],
): BurnEstimate | undefined {
  return rows.find((row) => row.windowType === windowType);
}

/**
 * What to print under a quota bar: which window it is, how much to trust it,
 * and whether it will last.
 *
 * A fresh reading gets its reset time, which is the number the operator plans
 * around. A stale one says so instead, because a bar drawn from an old reading
 * with a countdown beside it reads as live when it is not.
 *
 * The estimate is named only when the window runs out first. "You will not run
 * out" is already what the reset time says, and a far-off instant printed beside
 * it invites arithmetic nobody needs to do. The suppression cases above take
 * precedence and are guarded on the reading, not on whether a figure arrived:
 * an estimate nobody believes must never reach a bar.
 */
export function quotaLegend(
  window: QuotaWindow,
  now: number,
  pollIntervalMs: number,
  formatRelative: (at: number, now: number) => string,
  burn: BurnEstimate | undefined,
): string {
  const label = WINDOW_LABEL[window.windowType];
  if (window.observedAt <= 0) return `${label} · never observed`;
  if (isQuotaStale(window, now, pollIntervalMs)) {
    return `${label} · stale, read ${formatRelative(window.observedAt, now)}`;
  }
  if (window.resetsAt === null) return label;

  const reset = `resets ${formatRelative(window.resetsAt, now)}`;
  if (burn === undefined || burn.stale || burn.survives !== false || burn.exhaustsAt === null) {
    return `${label} · ${reset}`;
  }
  // A window at or past its ceiling ran out at some instant already behind us,
  // which is not a countdown an operator can act on.
  const empty =
    burn.exhaustsAt <= now ? "empty now" : `empty ~${formatDuration(burn.exhaustsAt - now)}`;
  return `${label} · ${empty} · ${reset}`;
}

export type QuotaPoint = { at: number; percent: number };

/** One unbroken run of readings inside a single window. */
export type QuotaSegment = {
  key: string;
  points: QuotaPoint[];
  /** The reset these readings were counting down to, as the provider stated it. */
  resetsAt: number | null;
  /** Where this run's own window began, or null when no reset was stated. */
  startsAt: number | null;
};

/**
 * Retained readings as percentages of their own ceiling, split per window.
 *
 * A rollover resets `used`, so a series drawn straight through one would fall
 * to the floor and read as a sudden refund. `resetsAt` moves on every rollover
 * and is the only signal that says so, which is what splits the runs here —
 * drawn as separate series, nothing connects the end of one window to the start
 * of the next.
 *
 * It is compared through `sameWindow`, the same predicate `saveQuota` dedups
 * on, and from the same definition: a provider stating a whole-second countdown
 * jitters its derived reset by milliseconds on every probe, and splitting on
 * that gives one single-point series per sample. A single-point `stepAfter`
 * line with `dot={false}` draws no stroke at all, so the panel would render
 * blank while a non-empty segment list suppressed the "not yet observed" note.
 *
 * Readings with no ceiling are dropped: a percentage of an unstated limit is
 * not a number, and drawing them at zero would claim an idle account.
 */
export function quotaSegments(samples: readonly QuotaSample[]): QuotaSegment[] {
  const usable = samples
    .filter((sample) => sample.limit !== null && sample.limit > 0)
    .sort((a, b) => a.observedAt - b.observedAt);

  const segments: QuotaSegment[] = [];
  let previous: QuotaSample | undefined;
  for (const sample of usable) {
    const point = {
      at: sample.observedAt,
      percent: Math.min(100, (sample.used / (sample.limit as number)) * 100),
    };
    // Each run carries its own window, taken from its newest reading: a
    // historical run reset hours ago and against its own length, and reusing
    // the current window's would place it on somebody else's timeline.
    const bounds = {
      resetsAt: sample.resetsAt,
      startsAt:
        sample.resetsAt === null
          ? null
          : sample.resetsAt - durationFor(sample.windowType, sample.windowMs),
    };
    const last = segments[segments.length - 1];
    if (
      last === undefined ||
      previous === undefined ||
      !sameWindow(sample.resetsAt, previous.resetsAt)
    ) {
      segments.push({ key: `window-${segments.length}`, points: [point], ...bounds });
    } else {
      last.points.push(point);
      last.resetsAt = bounds.resetsAt;
      last.startsAt = bounds.startsAt;
    }
    previous = sample;
  }
  return segments;
}

/** A straight run between two instants, as a percentage of the same ceiling. */
export type QuotaPace = { from: QuotaPoint; to: QuotaPoint };

/**
 * The pace that spends one window's allowance exactly as it resets.
 *
 * Drawn per run rather than once per panel, because the window before this one
 * had its own start and its own reset and the reading in it means nothing
 * against this window's. Null where the provider stated no reset: there is
 * neither an endpoint to draw to nor a start to count back from, and borrowing
 * the current window's would draw a pace nothing was measured against.
 */
export function budgetPace(segment: QuotaSegment): QuotaPace | null {
  if (segment.startsAt === null || segment.resetsAt === null) return null;
  return {
    from: { at: segment.startsAt, percent: 0 },
    to: { at: segment.resetsAt, percent: 100 },
  };
}

const HOUR_MS = 3_600_000;

/**
 * Where the current reading lands by the reset if it keeps going as it has.
 *
 * Anchored to `observedAt`, never to `now`: `used` is the provider's count as
 * of that instant and `ratePerHour` is averaged to it, so a projection started
 * anywhere else describes a reading that was never taken. The console refetches
 * far more often than the provider is probed, so anchoring to `now` would also
 * walk the line's start away from its own data between probes.
 *
 * Because both are drawn from that one anchor and that one rate, this line
 * crosses the ceiling exactly at the estimate's `exhaustsAt` — the two are the
 * same claim, and any disagreement between them is a bug in one of them.
 *
 * The rate is provider units per hour and the chart is a percentage, so it is
 * converted against the same ceiling the readings are drawn against. Staleness
 * is the caller's guard: a panel that does not believe its reading draws none
 * of this.
 */
export function projectedPace(window: QuotaWindow, estimate: BurnEstimate): QuotaPace | null {
  const { limit, resetsAt, observedAt, used } = window;
  const rate = estimate.ratePerHour;
  // Zero is not "holds steady": it is what a window with one reading reports,
  // and a flat line would promise it never moves again.
  if (limit === null || limit <= 0 || resetsAt === null || rate === null || rate <= 0) return null;

  const usedPercent = (used / limit) * 100;
  const percentPerHour = (rate / limit) * 100;
  return {
    from: { at: observedAt, percent: usedPercent },
    to: {
      at: resetsAt,
      percent: usedPercent + percentPerHour * ((resetsAt - observedAt) / HOUR_MS),
    },
  };
}

/** Shortest window first, so a row reads left-to-right from soonest to latest. */
const WINDOW_ORDER: Record<QuotaWindow["windowType"], number> = {
  fiveHour: 0,
  daily: 1,
  weekly: 2,
};

/**
 * Every window the provider reported, in duration order.
 *
 * All of them, not just the tightest: a five-hour window at 90% and a weekly
 * one at 20% mean "pause for an hour", while the reverse means "this account
 * is done for the week". Collapsing them to one bar throws away which of those
 * an operator is looking at.
 *
 * A window with no limit is dropped rather than drawn empty — the provider
 * reported usage without a ceiling, which is not the same as unused.
 */
export function quotaUsage(windows: readonly QuotaWindow[]): QuotaUse[] {
  return windows
    .filter((window) => window.limit !== null && window.limit > 0)
    .map((window) => ({
      window,
      fraction: Math.min(1, window.used / (window.limit as number)),
    }))
    .sort((a, b) => WINDOW_ORDER[a.window.windowType] - WINDOW_ORDER[b.window.windowType]);
}

/** Groups rows by credential id without assuming the server sorted them. */
export function groupBy<T, K extends string>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const id = key(row);
    const existing = map.get(id);
    if (existing === undefined) map.set(id, [row]);
    else existing.push(row);
  }
  return map;
}
