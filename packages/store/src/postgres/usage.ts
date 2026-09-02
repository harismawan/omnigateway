import type { ProviderId } from "@omni/ir";
import { isRtkFilterId } from "@omni/rtk/catalog";
import type { SQL } from "bun";
import { HOUR_MS, hourOf, startOfLocalDay } from "../sqlite/rollup.ts";
import {
  NODE_GRACE_MS,
  type RequestLog,
  type RequestState,
  type UsageBucket,
  type UsageDimension,
  type UsageGrain,
  type UsageQuery,
  type UsageRepo,
} from "../types.ts";
import { type Conn, num, numOrNull, type Rows } from "./db.ts";
import { auditRollup, rebuildRollup, rollupHour, rollupLog } from "./rollup.ts";

type Row = {
  id: string;
  state: string;
  at: string;
  api_key_id: string | null;
  requested_model: string;
  resolved_provider: string | null;
  resolved_model: string | null;
  credential_id: string | null;
  attempts: number;
  status: number;
  error_code: string | null;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  ttft_ms: string | null;
  duration_ms: string;
  cost_usd: number;
  degradations: string;
  rtk_applied: boolean;
  rtk_filter_hits: string;
  rtk_original_code_units: string;
  rtk_compressed_code_units: string;
  rtk_estimated_tokens_saved: string;
  rtk_filters: string;
};

function parseRtkFilters(raw: string): import("@omni/rtk/catalog").RtkFilterId[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRtkFilterId) : [];
  } catch {
    return [];
  }
}

const toLog = (r: Row): RequestLog => ({
  id: r.id,
  state: r.state === "pending" ? "pending" : "done",
  at: num(r.at),
  apiKeyId: r.api_key_id,
  requestedModel: r.requested_model,
  resolvedProvider: r.resolved_provider as ProviderId | null,
  resolvedModel: r.resolved_model,
  credentialId: r.credential_id,
  attempts: r.attempts,
  status: r.status,
  errorCode: r.error_code,
  inputTokens: num(r.input_tokens),
  outputTokens: num(r.output_tokens),
  cacheReadTokens: num(r.cache_read_tokens),
  cacheWriteTokens: num(r.cache_write_tokens),
  ttftMs: numOrNull(r.ttft_ms),
  durationMs: num(r.duration_ms),
  costUsd: r.cost_usd,
  degradations: JSON.parse(r.degradations) as string[],
  rtkApplied: r.rtk_applied,
  rtkFilterHits: num(r.rtk_filter_hits),
  rtkOriginalCodeUnits: num(r.rtk_original_code_units),
  rtkCompressedCodeUnits: num(r.rtk_compressed_code_units),
  rtkEstimatedTokensSaved: num(r.rtk_estimated_tokens_saved),
  rtkFilters: parseRtkFilters(r.rtk_filters),
});

/**
 * Whitelisted so a dimension can never reach SQL as raw text. `null` marks a
 * dimension the grain cannot answer: raw logs have no day column that agrees
 * with the host's local midnight, and the rollup has thrown the hour away.
 */
const GROUP_COLUMN: Readonly<Record<UsageGrain, Readonly<Record<UsageDimension, string | null>>>> =
  {
    raw: {
      credential: "credential_id",
      model: "resolved_model",
      requestedModel: "requested_model",
      apiKey: "api_key_id",
      provider: "resolved_provider",
      hour: "at / 3600000",
      day: null,
    },
    daily: {
      credential: "credential_id",
      model: "resolved_model",
      requestedModel: "requested_model",
      apiKey: "api_key_id",
      provider: "provider",
      hour: null,
      day: "day",
    },
  };

function columnFor(grain: UsageGrain, dimension: UsageDimension): string {
  const column = GROUP_COLUMN[grain][dimension];
  if (column === null) throw new Error(`usage grain ${grain} cannot group by ${dimension}`);
  return column;
}

/**
 * Raw logs count failures from the status; the rollup already stored them.
 *
 * Raw aggregation also excludes in-flight rows (see the `state` predicate in
 * `aggregate`): a pending row's zeros are placeholders, and counting one as a
 * request with no tokens would drag every mean toward zero. The rollup needs no
 * such filter — nothing writes it until a request completes.
 */
const MEASURES: Readonly<Record<UsageGrain, string>> = {
  raw: `COUNT(*) AS requests,
        COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(SUM(duration_ms), 0) AS duration_ms_sum`,
  daily: `COALESCE(SUM(requests), 0) AS requests,
          COALESCE(SUM(errors), 0) AS errors,
          COALESCE(SUM(duration_ms_sum), 0) AS duration_ms_sum`,
};

type Agg = {
  key: string | number | null;
  split: string | number | null;
  requests: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  rtk_saved_tokens: string;
  rtk_applied_requests: string;
  cost_usd: number;
  errors: string;
  duration_ms_sum: string;
};

type SumRow = { requests: string; tokens: string; cost_usd: number };

/** An absent credential, key, or upstream model is a bucket, not a hole. */
function label(value: string | number | null): string {
  if (value === null) return "unknown";
  const text = String(value);
  return text.length === 0 ? "unknown" : text;
}

const COLUMNS = `(id, state, node_id, at, api_key_id, requested_model, resolved_provider,
                  resolved_model, credential_id, attempts, status, error_code, input_tokens,
                  output_tokens, cache_read_tokens, cache_write_tokens, ttft_ms, duration_ms,
                  cost_usd, degradations, rtk_applied, rtk_filter_hits, rtk_original_code_units,
                  rtk_compressed_code_units, rtk_estimated_tokens_saved, rtk_filters)`;

const PLACEHOLDERS = `(${Array.from({ length: 26 }, (_, i) => `$${i + 1}`).join(",")})`;

function values(log: RequestLog, state: RequestState, nodeId: string): unknown[] {
  return [
    log.id,
    state,
    nodeId,
    log.at,
    log.apiKeyId,
    log.requestedModel,
    log.resolvedProvider,
    log.resolvedModel,
    log.credentialId,
    log.attempts,
    log.status,
    log.errorCode,
    log.inputTokens,
    log.outputTokens,
    log.cacheReadTokens,
    log.cacheWriteTokens,
    log.ttftMs,
    log.durationMs,
    log.costUsd,
    JSON.stringify(log.degradations),
    log.rtkApplied === true,
    log.rtkFilterHits ?? 0,
    log.rtkOriginalCodeUnits ?? 0,
    log.rtkCompressedCodeUnits ?? 0,
    log.rtkEstimatedTokensSaved ?? 0,
    JSON.stringify(log.rtkFilters ?? []),
  ];
}

/**
 * Completion upserts, because it serves both a request that began and one that
 * failed before dispatch ever ran.
 *
 * Three columns are deliberately not overwritten. `at` is omitted entirely, so
 * a row keeps the start time it was filed under and does not jump position in
 * the log the instant it finishes. `requested_model` and `api_key_id` fall back
 * to what the row already holds, because the route's terminal catch can reach a
 * row that already began — when dispatch throws rather than yielding an error
 * event — and the log it completes may carry neither.
 */
const COMPLETE = `INSERT INTO request_logs ${COLUMNS} VALUES ${PLACEHOLDERS}
  ON CONFLICT (id) DO UPDATE SET
    state = 'done',
    requested_model = COALESCE(NULLIF(EXCLUDED.requested_model, ''), request_logs.requested_model),
    api_key_id = COALESCE(EXCLUDED.api_key_id, request_logs.api_key_id),
    resolved_provider = EXCLUDED.resolved_provider,
    resolved_model = EXCLUDED.resolved_model,
    credential_id = EXCLUDED.credential_id,
    attempts = EXCLUDED.attempts,
    status = EXCLUDED.status,
    error_code = EXCLUDED.error_code,
    input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cache_read_tokens = EXCLUDED.cache_read_tokens,
    cache_write_tokens = EXCLUDED.cache_write_tokens,
    ttft_ms = EXCLUDED.ttft_ms,
    duration_ms = EXCLUDED.duration_ms,
    cost_usd = EXCLUDED.cost_usd,
    degradations = EXCLUDED.degradations,
    rtk_applied = EXCLUDED.rtk_applied,
    rtk_filter_hits = EXCLUDED.rtk_filter_hits,
    rtk_original_code_units = EXCLUDED.rtk_original_code_units,
    rtk_compressed_code_units = EXCLUDED.rtk_compressed_code_units,
    rtk_estimated_tokens_saved = EXCLUDED.rtk_estimated_tokens_saved,
    rtk_filters = EXCLUDED.rtk_filters`;

const sum = (row: SumRow | undefined) => ({
  requests: row === undefined ? 0 : num(row.requests),
  tokens: row === undefined ? 0 : num(row.tokens),
  costUsd: row === undefined ? 0 : row.cost_usd,
});

export function createUsageRepo(sql: SQL, nodeId: string): UsageRepo {
  /**
   * The raw row and both rollups are written together: a crash between them
   * would leave the year view, or a key's hourly counters, quietly disagreeing
   * with the log they summarize.
   *
   * The rollups are fed from the stored row rather than from the argument, so
   * they summarize what the log actually says even where the upsert kept a
   * column the completing log did not carry.
   */
  const complete = async (conn: Conn, log: RequestLog): Promise<void> => {
    await conn.unsafe(COMPLETE, values(log, "done", nodeId));
    const stored = (
      await conn.unsafe<Rows<Row>>("SELECT * FROM request_logs WHERE id = $1", [log.id])
    )[0];
    if (stored !== undefined) {
      const restored = toLog(stored);
      await rollupLog(conn, restored);
      await rollupHour(conn, restored);
    }
  };

  return {
    async begin(log: RequestLog) {
      await sql.unsafe(
        `INSERT INTO request_logs ${COLUMNS} VALUES ${PLACEHOLDERS}`,
        values(log, "pending", nodeId),
      );
    },

    async route(id, target) {
      await sql.unsafe(
        `UPDATE request_logs
            SET resolved_provider = $1, resolved_model = $2, credential_id = $3
          WHERE id = $4 AND state = 'pending'`,
        [target.provider, target.model, target.credentialId, id],
      );
    },

    async append(log: RequestLog) {
      await sql.begin((tx) => complete(tx, log));
    },

    async sweepPending(now) {
      // Own rows, or rows of a node with no live heartbeat. `NOT IN` against
      // the live set rather than a join on the dead set, because a node that
      // never wrote a heartbeat has no row to join against and is dead too.
      const stale = (
        await sql.unsafe<Rows<Row>>(
          `SELECT * FROM request_logs
            WHERE state = 'pending'
              AND (node_id = $1 OR node_id NOT IN (SELECT id FROM nodes WHERE seen_at > $2))`,
          [nodeId, now - NODE_GRACE_MS],
        )
      ).map(toLog);
      for (const log of stale) {
        // Through the same path as a real completion, so the daily rollup keeps
        // agreeing with the rows it summarizes.
        //
        // Zero duration, not elapsed-since-start: nobody knows when the process
        // died, and a row pending across a weekend of downtime would otherwise
        // put two days into the mean latency of the day it started on.
        await sql.begin((tx) =>
          complete(tx, { ...log, status: 499, errorCode: "interrupted", durationMs: 0 }),
        );
      }
      return stale.length;
    },

    async recent(limit: number, apiKeyId?: string) {
      // `= $1` never matches NULL, so an anonymous row falls out of a scoped
      // read on its own. That is the wanted answer and not an accident of SQL:
      // an untagged request belongs to no key, so no key may read it.
      const rows =
        apiKeyId === undefined
          ? await sql.unsafe<Rows<Row>>("SELECT * FROM request_logs ORDER BY at DESC LIMIT $1", [
              limit,
            ])
          : await sql.unsafe<Rows<Row>>(
              "SELECT * FROM request_logs WHERE api_key_id = $1 ORDER BY at DESC LIMIT $2",
              [apiKeyId, limit],
            );
      return rows.map(toLog);
    },

    async sumSince(apiKeyId: string, sinceMs: number) {
      // Two reads, and neither grows with how long the install has been running.
      //
      // `sinceMs` lands inside an hour rather than on one, so the bucket holding
      // it is the only one the rollup cannot answer for. The sum is (buckets
      // strictly after the boundary hour) plus (the rows of the boundary hour
      // at or after the instant), which keeps the exact sliding semantics the
      // limiter is specified against while bounding the scan to one hour of one
      // key's traffic.
      const boundary = hourOf(sinceMs);
      const whole = await sql.unsafe<Rows<SumRow>>(
        `SELECT COALESCE(SUM(requests), 0) AS requests,
                COALESCE(SUM(input_tokens + output_tokens
                             + cache_read_tokens + cache_write_tokens), 0) AS tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
           FROM usage_rollup
          WHERE api_key_id = $1 AND hour > $2`,
        [apiKeyId, boundary],
      );
      // `state = 'done'` is load-bearing, not hygiene: a pending row carries
      // placeholder zeros where its metrics will go, so an unfiltered edge scan
      // counts every in-flight request as a request and inflates the count.
      const edge = await sql.unsafe<Rows<SumRow>>(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(input_tokens + output_tokens
                             + cache_read_tokens + cache_write_tokens), 0) AS tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
           FROM request_logs
          WHERE api_key_id = $1 AND state = 'done' AND at >= $2 AND at < $3`,
        [apiKeyId, sinceMs, (boundary + 1) * HOUR_MS],
      );
      // A key with no rows in the window is zero, never unknown: both rows
      // always come back because each query is an aggregate over no groups.
      const a = sum(whole[0]);
      const b = sum(edge[0]);
      return {
        requests: a.requests + b.requests,
        tokens: a.tokens + b.tokens,
        costUsd: a.costUsd + b.costUsd,
      };
    },

    async sumBuckets(apiKeyId, sinceMs, grainMs) {
      type BucketRow = SumRow & { bucket: string };
      const rows =
        grainMs === HOUR_MS
          ? await sql.unsafe<Rows<BucketRow>>(
              `SELECT hour * ${HOUR_MS} AS bucket, requests,
                      input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
                        AS tokens,
                      cost_usd
                 FROM usage_rollup
                WHERE api_key_id = $1 AND hour >= $2`,
              [apiKeyId, hourOf(sinceMs)],
            )
          : await sql.unsafe<Rows<BucketRow>>(
              `SELECT (at / $1) * $2 AS bucket, COUNT(*) AS requests,
                      COALESCE(SUM(input_tokens + output_tokens
                                   + cache_read_tokens + cache_write_tokens), 0) AS tokens,
                      COALESCE(SUM(cost_usd), 0) AS cost_usd
                 FROM request_logs
                WHERE api_key_id = $3 AND state = 'done' AND at >= $4
                GROUP BY 1`,
              [grainMs, grainMs, apiKeyId, sinceMs],
            );
      return rows.map((row) => [num(row.bucket), sum(row)]);
    },

    async rebuildRollup() {
      await sql.begin((tx) => rebuildRollup(tx));
    },

    async auditRollup() {
      return auditRollup(sql);
    },

    async oldestSince(apiKeyId: string, sinceMs: number) {
      // `state = 'done'` for the same reason `sumSince` carries it: a pending
      // row is a placeholder rather than a measurement, and one written a
      // moment ago would answer that this window frees nothing for a whole
      // window — the exact overstatement this query exists to replace.
      const row = (
        await sql.unsafe<Rows<{ at: string | null }>>(
          `SELECT MIN(at) AS at
             FROM request_logs
            WHERE api_key_id = $1 AND state = 'done' AND at >= $2`,
          [apiKeyId, sinceMs],
        )
      )[0];
      // `MIN` over no rows is a row holding null, not an absent row. Both mean
      // the same thing here: the key has nothing retained inside the window.
      return row === undefined ? null : numOrNull(row.at);
    },

    async aggregate(q: UsageQuery) {
      const grain = q.grain ?? "raw";
      const daily = grain === "daily";
      const key = columnFor(grain, q.groupBy);
      const split = q.splitBy === undefined ? null : columnFor(grain, q.splitBy);

      // A daily bucket is whole: floor the lower bound so the first partial day
      // of the window is reported in full rather than dropped.
      const since = daily ? startOfLocalDay(q.since) : q.since;
      const until = q.until ?? Number.MAX_SAFE_INTEGER;
      const timeColumn = daily ? "day" : "at";

      // A WHERE, so it constrains the rows before grouping and therefore applies
      // to every dimension — `groupBy: "apiKey"` under a scope reports the one
      // key rather than announcing that others exist.
      const scope = q.apiKeyId;
      const bindings: unknown[] = scope === undefined ? [since, until] : [since, until, scope];

      const rows = await sql.unsafe<Rows<Agg>>(
        `SELECT ${key} AS key,
                ${split ?? "NULL"} AS split,
                ${MEASURES[grain]},
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                COALESCE(SUM(${daily ? "rtk_saved_tokens" : "rtk_estimated_tokens_saved"}), 0) AS rtk_saved_tokens,
                COALESCE(SUM(${daily ? "rtk_applied_requests" : "CASE WHEN rtk_applied THEN 1 ELSE 0 END"}), 0) AS rtk_applied_requests,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
           FROM ${daily ? "usage_daily" : "request_logs"}
          WHERE ${daily ? "" : "state = 'done' AND "}${timeColumn} >= $1 AND ${timeColumn} <= $2${scope === undefined ? "" : " AND api_key_id = $3"}
          GROUP BY 1${split === null ? "" : ", 2"}
          ORDER BY requests DESC`,
        bindings,
      );

      return rows.map((r): UsageBucket => {
        const bucket: UsageBucket = {
          key: label(r.key),
          requests: num(r.requests),
          inputTokens: num(r.input_tokens),
          outputTokens: num(r.output_tokens),
          cacheReadTokens: num(r.cache_read_tokens),
          cacheWriteTokens: num(r.cache_write_tokens),
          rtkSavedTokens: num(r.rtk_saved_tokens),
          rtkAppliedRequests: num(r.rtk_applied_requests),
          costUsd: r.cost_usd,
          errors: num(r.errors),
          durationMsSum: num(r.duration_ms_sum),
        };
        return split === null ? bucket : { ...bucket, split: label(r.split) };
      });
    },

    /**
     * Retention applied to the derived counters as well as to the rows.
     *
     * Without this the rollup keeps counting requests whose rows are gone, and
     * every long window — and `doctor`'s comparison of the two — reports history
     * the log no longer holds. Buckets below the boundary go whole; the one
     * boundary hour straddles the cut, so it is recomputed from what survived
     * rather than adjusted.
     */
    async prune(olderThan: number) {
      return sql.begin(async (tx): Promise<number> => {
        const removed = (await tx.unsafe("DELETE FROM request_logs WHERE at < $1", [olderThan]))
          .count;
        const boundary = hourOf(olderThan);
        await tx.unsafe("DELETE FROM usage_rollup WHERE hour <= $1", [boundary]);
        await tx.unsafe(
          `INSERT INTO usage_rollup
             (api_key_id, hour, requests, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd)
           SELECT api_key_id, $1::bigint, COUNT(*),
                  COALESCE(SUM(input_tokens), 0),
                  COALESCE(SUM(output_tokens), 0),
                  COALESCE(SUM(cache_read_tokens), 0),
                  COALESCE(SUM(cache_write_tokens), 0),
                  COALESCE(SUM(cost_usd), 0)
             FROM request_logs
            WHERE state = 'done' AND api_key_id IS NOT NULL AND at >= $2 AND at < $3
            GROUP BY api_key_id`,
          [boundary, boundary * HOUR_MS, (boundary + 1) * HOUR_MS],
        );
        return removed;
      });
    },

    async pruneDaily(olderThan: number) {
      return (await sql.unsafe("DELETE FROM usage_daily WHERE day < $1", [olderThan])).count;
    },
  };
}
