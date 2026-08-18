import type { Database } from "bun:sqlite";
import type { RequestLog, RollupAudit } from "../types.ts";

export const HOUR_MS = 3_600_000;

/**
 * The bucket an instant belongs to, as `usage_rollup.hour` holds it.
 *
 * `Math.floor` and SQLite's integer division disagree below the epoch and
 * nowhere above it, so this and the `at / 3600000` in `rebuildRollup` describe
 * the same bucket for every timestamp a request log can carry.
 */
export function hourOf(at: number): number {
  return Math.floor(at / HOUR_MS);
}

/**
 * The epoch of the host's local midnight containing `at`.
 *
 * Local rather than UTC because the gateway is single-node and single-operator:
 * the host's day is the operator's day. `setHours` walks the calendar rather
 * than subtracting a fixed 24h, so a DST transition still lands on midnight.
 */
export function startOfLocalDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Counters a single request contributes to its day's row. */
type Counters = {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  rtkSavedTokens: number;
  rtkAppliedRequests: number;
  costUsd: number;
  durationMsSum: number;
};

/** The tuple a row is keyed by, with empty strings where the log had nulls. */
type Key = [
  day: number,
  provider: string,
  credentialId: string,
  requestedModel: string,
  resolvedModel: string,
  apiKeyId: string,
];

const UPSERT = `
  INSERT INTO usage_daily
    (day, provider, credential_id, requested_model, resolved_model, api_key_id,
     requests, errors, input_tokens, output_tokens, cache_read_tokens,
     cache_write_tokens, rtk_saved_tokens, rtk_applied_requests, cost_usd, duration_ms_sum)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT (day, provider, credential_id, requested_model, resolved_model, api_key_id)
  DO UPDATE SET
    requests           = requests + excluded.requests,
    errors             = errors + excluded.errors,
    input_tokens       = input_tokens + excluded.input_tokens,
    output_tokens      = output_tokens + excluded.output_tokens,
    cache_read_tokens  = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens    = cache_write_tokens + excluded.cache_write_tokens,
    rtk_saved_tokens      = rtk_saved_tokens + excluded.rtk_saved_tokens,
    rtk_applied_requests  = rtk_applied_requests + excluded.rtk_applied_requests,
    cost_usd              = cost_usd + excluded.cost_usd,
    duration_ms_sum    = duration_ms_sum + excluded.duration_ms_sum`;

function keyOf(log: RequestLog): Key {
  return [
    startOfLocalDay(log.at),
    log.resolvedProvider ?? "",
    log.credentialId ?? "",
    log.requestedModel,
    log.resolvedModel ?? "",
    log.apiKeyId ?? "",
  ];
}

function countersOf(log: RequestLog): Counters {
  return {
    requests: 1,
    errors: log.status >= 400 ? 1 : 0,
    inputTokens: log.inputTokens,
    outputTokens: log.outputTokens,
    cacheReadTokens: log.cacheReadTokens,
    cacheWriteTokens: log.cacheWriteTokens,
    rtkSavedTokens: log.rtkEstimatedTokensSaved,
    rtkAppliedRequests: log.rtkApplied ? 1 : 0,
    costUsd: log.costUsd,
    durationMsSum: log.durationMs,
  };
}

function upsert(db: Database, key: Key, c: Counters): void {
  db.run(UPSERT, [
    ...key,
    c.requests,
    c.errors,
    c.inputTokens,
    c.outputTokens,
    c.cacheReadTokens,
    c.cacheWriteTokens,
    c.rtkSavedTokens,
    c.rtkAppliedRequests,
    c.costUsd,
    c.durationMsSum,
  ]);
}

/**
 * Folds one finished request into its daily row. The caller runs this inside
 * the same transaction as the raw log insert, so the rollup can never disagree
 * with the rows it summarizes.
 */
export function rollupLog(db: Database, log: RequestLog): void {
  upsert(db, keyOf(log), countersOf(log));
}

type BackfillRow = {
  at: number;
  api_key_id: string | null;
  requested_model: string;
  resolved_provider: string | null;
  resolved_model: string | null;
  credential_id: string | null;
  status: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  duration_ms: number;
  cost_usd: number;
};

/**
 * Seeds `usage_daily` from the raw logs already on disk, so an existing
 * install has a populated year view on the first boot after the migration
 * instead of an empty grid for a month.
 *
 * Aggregates in memory first: one upsert per distinct tuple rather than one per
 * request, which matters on a database holding a month of traffic. Runs inside
 * the migration's transaction, so it must not open one of its own.
 *
 * Returns the number of rows written.
 */
export function backfillDaily(db: Database): number {
  const groups = new Map<string, { key: Key; counters: Counters }>();

  for (const row of db
    .query<BackfillRow, []>(
      `SELECT at, api_key_id, requested_model, resolved_provider, resolved_model, credential_id,
              status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              duration_ms, cost_usd
         FROM request_logs`,
    )
    .all()) {
    const key: Key = [
      startOfLocalDay(row.at),
      row.resolved_provider ?? "",
      row.credential_id ?? "",
      row.requested_model,
      row.resolved_model ?? "",
      row.api_key_id ?? "",
    ];
    const id = key.join("\0");
    const seen = groups.get(id);
    const counters = seen?.counters ?? {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      rtkSavedTokens: 0,
      rtkAppliedRequests: 0,
      costUsd: 0,
      durationMsSum: 0,
    };
    counters.requests += 1;
    counters.errors += row.status >= 400 ? 1 : 0;
    counters.inputTokens += row.input_tokens;
    counters.outputTokens += row.output_tokens;
    counters.cacheReadTokens += row.cache_read_tokens;
    counters.cacheWriteTokens += row.cache_write_tokens;
    counters.costUsd += row.cost_usd;
    counters.durationMsSum += row.duration_ms;
    if (seen === undefined) groups.set(id, { key, counters });
  }

  for (const group of groups.values()) upsert(db, group.key, group.counters);
  return groups.size;
}

const HOURLY_UPSERT = `
  INSERT INTO usage_rollup
    (api_key_id, hour, requests, input_tokens, output_tokens,
     cache_read_tokens, cache_write_tokens, cost_usd)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT (api_key_id, hour)
  DO UPDATE SET
    requests           = requests + excluded.requests,
    input_tokens       = input_tokens + excluded.input_tokens,
    output_tokens      = output_tokens + excluded.output_tokens,
    cache_read_tokens  = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    cost_usd           = cost_usd + excluded.cost_usd`;

/**
 * Folds one finished request into its key's hourly bucket.
 *
 * Called from the same transaction as the raw log insert, beside `rollupLog`,
 * so the derived counter cannot land without the row it derives from and pays
 * no fsync of its own. It inherits `append`'s at-most-once-per-request-id
 * guarantee from that placement rather than establishing a second one.
 *
 * An anonymous request has no key to count against and no reader that could
 * ever ask for it, so it is skipped rather than bucketed under a sentinel.
 */
export function rollupHour(db: Database, log: RequestLog): void {
  const apiKeyId = log.apiKeyId;
  if (apiKeyId === null) return;
  db.run(HOURLY_UPSERT, [
    apiKeyId,
    hourOf(log.at),
    1,
    log.inputTokens,
    log.outputTokens,
    log.cacheReadTokens,
    log.cacheWriteTokens,
    log.costUsd,
  ]);
}

/**
 * Every bucket `request_logs` says should exist, as one grouped select.
 *
 * The `state = 'done'` filter is the same one `sumSince` carries and is
 * load-bearing for the same reason: a pending row holds placeholder zeros where
 * its metrics will go, so counting one adds a request that never happened to
 * every window covering that hour.
 */
const REBUILD = `
  INSERT INTO usage_rollup
    (api_key_id, hour, requests, input_tokens, output_tokens,
     cache_read_tokens, cache_write_tokens, cost_usd)
  SELECT api_key_id,
         at / 3600000,
         COUNT(*),
         COALESCE(SUM(input_tokens), 0),
         COALESCE(SUM(output_tokens), 0),
         COALESCE(SUM(cache_read_tokens), 0),
         COALESCE(SUM(cache_write_tokens), 0),
         COALESCE(SUM(cost_usd), 0)
    FROM request_logs
   WHERE state = 'done' AND api_key_id IS NOT NULL
   GROUP BY api_key_id, at / 3600000`;

/**
 * Recomputes `usage_rollup` from `request_logs`, whole.
 *
 * This is what makes the table safe to depend on. A derived counter that cannot
 * be reproduced is a second source of truth, and a disagreement between two
 * sources of truth is unresolvable; a derived counter with a rebuild is a cache,
 * and a stale cache is repairable. It runs as the `010` migration's backfill, on
 * the way out of a database restore, and nowhere on the request path.
 *
 * Runs inside the caller's transaction where there is one, so it must not open
 * one of its own.
 */
export function rebuildRollup(db: Database): void {
  db.run("DELETE FROM usage_rollup");
  db.run(REBUILD);
}

/**
 * Compares every bucket against the rows it summarises.
 *
 * A full grouped scan of `request_logs` — the exact cost the rollup exists to
 * keep off the request path — so this is a diagnostic an operator runs, never
 * something the gateway does to itself.
 *
 * Cost is compared with a tolerance because it is the one REAL column: the
 * rollup accumulates it a request at a time while this sums a whole bucket at
 * once, and IEEE addition is not associative. A drifting-by-an-ulp column is not
 * the failure this check exists to find.
 */
export function auditRollup(db: Database): RollupAudit {
  const row = db
    .query<{ buckets: number; mismatched: number; orphans: number }, []>(
      `WITH truth AS (
         SELECT api_key_id AS k,
                at / 3600000 AS h,
                COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
           FROM request_logs
          WHERE state = 'done' AND api_key_id IS NOT NULL
          GROUP BY k, h
       )
       SELECT (SELECT COUNT(*) FROM truth) AS buckets,
              (SELECT COUNT(*)
                 FROM truth
                 LEFT JOIN usage_rollup r ON r.api_key_id = truth.k AND r.hour = truth.h
                WHERE r.api_key_id IS NULL
                   OR r.requests <> truth.requests
                   OR r.input_tokens <> truth.input_tokens
                   OR r.output_tokens <> truth.output_tokens
                   OR r.cache_read_tokens <> truth.cache_read_tokens
                   OR r.cache_write_tokens <> truth.cache_write_tokens
                   OR ABS(r.cost_usd - truth.cost_usd) > 1e-9 + ABS(truth.cost_usd) * 1e-9
              ) AS mismatched,
              (SELECT COUNT(*)
                 FROM usage_rollup r
                 LEFT JOIN truth ON r.api_key_id = truth.k AND r.hour = truth.h
                WHERE truth.k IS NULL
              ) AS orphans`,
    )
    .get();
  const buckets = row?.buckets ?? 0;
  // A bucket the rollup holds and the log does not is as wrong as one that
  // disagrees, and it is the shape a missing prune leaves behind.
  const mismatched = (row?.mismatched ?? 0) + (row?.orphans ?? 0);
  return { buckets, mismatched, ok: mismatched === 0 };
}

/** Backfills only RTK measures without adding the existing usage counters twice. */
export function backfillRtkUsage(db: Database): void {
  type RtkBackfillRow = Pick<
    BackfillRow,
    | "at"
    | "api_key_id"
    | "requested_model"
    | "resolved_provider"
    | "resolved_model"
    | "credential_id"
  > & {
    rtk_applied: number;
    rtk_estimated_tokens_saved: number;
  };
  const groups = new Map<string, { key: Key; saved: number; applied: number }>();
  for (const row of db
    .query<RtkBackfillRow, []>(
      `SELECT at, api_key_id, requested_model, resolved_provider, resolved_model, credential_id,
              rtk_applied, rtk_estimated_tokens_saved
         FROM request_logs
        WHERE state = 'done'`,
    )
    .all()) {
    const key: Key = [
      startOfLocalDay(row.at),
      row.resolved_provider ?? "",
      row.credential_id ?? "",
      row.requested_model,
      row.resolved_model ?? "",
      row.api_key_id ?? "",
    ];
    const id = key.join("\0");
    const group = groups.get(id) ?? { key, saved: 0, applied: 0 };
    group.saved += row.rtk_estimated_tokens_saved;
    group.applied += row.rtk_applied === 1 ? 1 : 0;
    groups.set(id, group);
  }

  for (const { key, saved, applied } of groups.values()) {
    db.run(
      `UPDATE usage_daily
          SET rtk_saved_tokens = ?, rtk_applied_requests = ?
        WHERE day = ? AND provider = ? AND credential_id = ? AND requested_model = ?
          AND resolved_model = ? AND api_key_id = ?`,
      [saved, applied, ...key],
    );
  }
}
