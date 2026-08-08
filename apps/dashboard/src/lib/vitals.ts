import type { CredentialHealth, QuotaWindow, RequestLog } from "../api/types.ts";

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
};

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? null;
}

/** A log row counts as an error on any non-2xx status the gateway recorded. */
export function isError(log: RequestLog): boolean {
  return log.status >= 400 || log.errorCode !== null;
}

export function summarize(logs: readonly RequestLog[], windowMs: number): Vitals {
  const ttfts: number[] = [];
  let errors = 0;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  for (const log of logs) {
    if (isError(log)) errors += 1;
    if (log.ttftMs !== null && Number.isFinite(log.ttftMs)) ttfts.push(log.ttftMs);
    costUsd += log.costUsd;
    inputTokens += log.inputTokens;
    outputTokens += log.outputTokens;
    cacheReadTokens += log.cacheReadTokens;
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
  };
}

export type Bucket = {
  at: number;
  total: number;
  errors: number;
  costUsd: number;
  /** Median first-token latency inside the bucket, or null if nothing streamed. */
  ttftMs: number | null;
};

/**
 * Buckets logs into a fixed number of equal slices ending at `now`, oldest
 * first, so a sparkline always has the same number of points and a quiet
 * gateway draws a flat line rather than an empty box.
 */
export function bucketLogs(
  logs: readonly RequestLog[],
  options: { now: number; spanMs: number; count: number },
): Bucket[] {
  const { now, spanMs, count } = options;
  const width = spanMs / count;
  const start = now - spanMs;
  const buckets: Bucket[] = Array.from({ length: count }, (_, i) => ({
    at: start + i * width,
    total: 0,
    errors: 0,
    costUsd: 0,
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
    if (isError(log)) bucket.errors += 1;
    if (log.ttftMs !== null && Number.isFinite(log.ttftMs)) latencies[index]?.push(log.ttftMs);
  }

  for (const [index, bucket] of buckets.entries()) {
    bucket.ttftMs = percentile(latencies[index] ?? [], 0.5);
  }
  return buckets;
}

export type LampState = "ok" | "warn" | "down" | "idle";

export const LAMP_GLYPH: Record<LampState, string> = {
  ok: "●",
  warn: "◐",
  down: "○",
  idle: "·",
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
): CredentialStatus {
  if (!enabled) {
    return {
      state: "idle",
      note: "disabled",
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

/** The window closest to exhaustion, which is the one that will block first. */
export function tightestQuota(windows: readonly QuotaWindow[]): QuotaUse | null {
  let tightest: QuotaUse | null = null;
  for (const window of windows) {
    if (window.limit === null || window.limit <= 0) continue;
    const fraction = Math.min(1, window.used / window.limit);
    if (tightest === null || fraction > tightest.fraction) tightest = { window, fraction };
  }
  return tightest;
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
