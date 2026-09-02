import { hourOf, startOfLocalDay } from "../sqlite/rollup.ts";
import type { RequestLog, RollupAudit } from "../types.ts";
import { type Conn, num, type Rows } from "./db.ts";

/**
 * The two rollups the SQLite store keeps, written the same way here. The
 * bucket arithmetic — `hourOf`, `startOfLocalDay` — is imported from the
 * SQLite module rather than copied: it is pure, and a second copy of "which
 * hour is this instant in" is one that can disagree with `omni doctor`.
 *
 * Every counter update is `n = n + EXCLUDED.n`, which is what makes
 * `sweepPending`'s node scoping load-bearing: nothing else may complete a row
 * twice, because a second completion would add rather than replace.
 */

const DAILY_UPSERT = `
  INSERT INTO usage_daily
    (day, provider, credential_id, requested_model, resolved_model, api_key_id,
     requests, errors, input_tokens, output_tokens, cache_read_tokens,
     cache_write_tokens, rtk_saved_tokens, rtk_applied_requests, cost_usd, duration_ms_sum)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
  ON CONFLICT (day, provider, credential_id, requested_model, resolved_model, api_key_id)
  DO UPDATE SET
    requests             = usage_daily.requests + EXCLUDED.requests,
    errors               = usage_daily.errors + EXCLUDED.errors,
    input_tokens         = usage_daily.input_tokens + EXCLUDED.input_tokens,
    output_tokens        = usage_daily.output_tokens + EXCLUDED.output_tokens,
    cache_read_tokens    = usage_daily.cache_read_tokens + EXCLUDED.cache_read_tokens,
    cache_write_tokens   = usage_daily.cache_write_tokens + EXCLUDED.cache_write_tokens,
    rtk_saved_tokens     = usage_daily.rtk_saved_tokens + EXCLUDED.rtk_saved_tokens,
    rtk_applied_requests = usage_daily.rtk_applied_requests + EXCLUDED.rtk_applied_requests,
    cost_usd             = usage_daily.cost_usd + EXCLUDED.cost_usd,
    duration_ms_sum      = usage_daily.duration_ms_sum + EXCLUDED.duration_ms_sum`;

/**
 * Folds one finished request into its daily row. The caller runs this inside
 * the same transaction as the raw log insert, so the rollup can never disagree
 * with the rows it summarizes. Empty strings where the log had nulls, because
 * the primary key treats NULLs as distinct.
 */
export async function rollupLog(conn: Conn, log: RequestLog): Promise<void> {
  await conn.unsafe(DAILY_UPSERT, [
    startOfLocalDay(log.at),
    log.resolvedProvider ?? "",
    log.credentialId ?? "",
    log.requestedModel,
    log.resolvedModel ?? "",
    log.apiKeyId ?? "",
    1,
    log.status >= 400 ? 1 : 0,
    log.inputTokens,
    log.outputTokens,
    log.cacheReadTokens,
    log.cacheWriteTokens,
    log.rtkEstimatedTokensSaved,
    log.rtkApplied ? 1 : 0,
    log.costUsd,
    log.durationMs,
  ]);
}

const HOURLY_UPSERT = `
  INSERT INTO usage_rollup
    (api_key_id, hour, requests, input_tokens, output_tokens,
     cache_read_tokens, cache_write_tokens, cost_usd)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  ON CONFLICT (api_key_id, hour)
  DO UPDATE SET
    requests           = usage_rollup.requests + EXCLUDED.requests,
    input_tokens       = usage_rollup.input_tokens + EXCLUDED.input_tokens,
    output_tokens      = usage_rollup.output_tokens + EXCLUDED.output_tokens,
    cache_read_tokens  = usage_rollup.cache_read_tokens + EXCLUDED.cache_read_tokens,
    cache_write_tokens = usage_rollup.cache_write_tokens + EXCLUDED.cache_write_tokens,
    cost_usd           = usage_rollup.cost_usd + EXCLUDED.cost_usd`;

/**
 * Folds one finished request into its key's hourly bucket, beside `rollupLog`
 * in the same transaction. An anonymous request has no key to count against
 * and no reader that could ever ask for it, so it is skipped rather than
 * bucketed under a sentinel.
 */
export async function rollupHour(conn: Conn, log: RequestLog): Promise<void> {
  const apiKeyId = log.apiKeyId;
  if (apiKeyId === null) return;
  await conn.unsafe(HOURLY_UPSERT, [
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
 * Every bucket `request_logs` says should exist, as one grouped select. The
 * `state = 'done'` filter is the same one `sumSince` carries and is
 * load-bearing for the same reason: a pending row holds placeholder zeros.
 *
 * Plain integer division, where the SQLite side casts: `at` is a BIGINT here,
 * so a fractional epoch was rounded on the way in and the write path's
 * `hourOf` read the stored, rounded value. The two agree by construction.
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
 * Recomputes `usage_rollup` from `request_logs`, whole. Runs inside the
 * caller's transaction where there is one, so it must not open one of its own.
 */
export async function rebuildRollup(conn: Conn): Promise<void> {
  await conn.unsafe("DELETE FROM usage_rollup");
  await conn.unsafe(REBUILD);
}

/**
 * Compares every bucket against the rows it summarises. A full grouped scan,
 * so this is a diagnostic an operator runs, never something the gateway does
 * to itself. Cost is compared with a tolerance because it is the one REAL
 * column and IEEE addition is not associative.
 */
export async function auditRollup(conn: Conn): Promise<RollupAudit> {
  const row = (
    await conn.unsafe<Rows<{ buckets: string; mismatched: string; orphans: string }>>(
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
  )[0];
  const buckets = row === undefined ? 0 : num(row.buckets);
  // A bucket the rollup holds and the log does not is as wrong as one that
  // disagrees, and it is the shape a missing prune leaves behind.
  const mismatched = row === undefined ? 0 : num(row.mismatched) + num(row.orphans);
  return { buckets, mismatched, ok: mismatched === 0 };
}
