import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { ProviderId } from "@omni/ir";
import { isRtkFilterId } from "@omni/rtk/catalog";
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
import {
  auditRollup,
  HOUR_MS,
  hourOf,
  rebuildRollup,
  rollupHour,
  rollupLog,
  startOfLocalDay,
} from "./rollup.ts";

type Row = {
  id: string;
  state: string;
  at: number;
  api_key_id: string | null;
  requested_model: string;
  resolved_provider: string | null;
  resolved_model: string | null;
  credential_id: string | null;
  attempts: number;
  status: number;
  error_code: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  ttft_ms: number | null;
  duration_ms: number;
  cost_usd: number;
  degradations: string;
  rtk_applied: number;
  rtk_filter_hits: number;
  rtk_original_code_units: number;
  rtk_compressed_code_units: number;
  rtk_estimated_tokens_saved: number;
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
  at: r.at,
  apiKeyId: r.api_key_id,
  requestedModel: r.requested_model,
  resolvedProvider: r.resolved_provider as ProviderId | null,
  resolvedModel: r.resolved_model,
  credentialId: r.credential_id,
  attempts: r.attempts,
  status: r.status,
  errorCode: r.error_code,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cacheReadTokens: r.cache_read_tokens,
  cacheWriteTokens: r.cache_write_tokens,
  ttftMs: r.ttft_ms,
  durationMs: r.duration_ms,
  costUsd: r.cost_usd,
  degradations: JSON.parse(r.degradations) as string[],
  rtkApplied: r.rtk_applied === 1,
  rtkFilterHits: r.rtk_filter_hits,
  rtkOriginalCodeUnits: r.rtk_original_code_units,
  rtkCompressedCodeUnits: r.rtk_compressed_code_units,
  rtkEstimatedTokensSaved: r.rtk_estimated_tokens_saved,
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
      // CAST for the same reason `rollup.ts` casts: `at` is contractually an
      // integer epoch, but nothing enforces it, and a fractional one would
      // group into REAL buckets no integer-keyed reader ever matches. Harmless
      // here where the value is a report label rather than a stored key, and
      // free, so the two hour expressions in this package agree by construction
      // rather than by both being fed well-formed input.
      hour: "CAST(at / 3600000 AS INTEGER)",
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
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  rtk_saved_tokens: number;
  rtk_applied_requests: number;
  cost_usd: number;
  errors: number;
  duration_ms_sum: number;
};

type SumRow = { requests: number; tokens: number; cost_usd: number };

type OldestRow = { at: number | null };

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

const PLACEHOLDERS = "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";

function values(log: RequestLog, state: RequestState, nodeId: string): SQLQueryBindings[] {
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
    log.rtkApplied === true ? 1 : 0,
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
 * event — and the log it completes may carry neither. It hands over dispatch's
 * own log where the request got that far, and a blank one only where it did
 * not, so the fallback covers the second case rather than every case.
 */
const COMPLETE = `INSERT INTO request_logs ${COLUMNS} VALUES ${PLACEHOLDERS}
  ON CONFLICT(id) DO UPDATE SET
    state = 'done',
    requested_model = COALESCE(NULLIF(excluded.requested_model, ''), request_logs.requested_model),
    api_key_id = COALESCE(excluded.api_key_id, request_logs.api_key_id),
    resolved_provider = excluded.resolved_provider,
    resolved_model = excluded.resolved_model,
    credential_id = excluded.credential_id,
    attempts = excluded.attempts,
    status = excluded.status,
    error_code = excluded.error_code,
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    cache_read_tokens = excluded.cache_read_tokens,
    cache_write_tokens = excluded.cache_write_tokens,
    ttft_ms = excluded.ttft_ms,
    duration_ms = excluded.duration_ms,
    cost_usd = excluded.cost_usd,
    degradations = excluded.degradations,
    rtk_applied = excluded.rtk_applied,
    rtk_filter_hits = excluded.rtk_filter_hits,
    rtk_original_code_units = excluded.rtk_original_code_units,
    rtk_compressed_code_units = excluded.rtk_compressed_code_units,
    rtk_estimated_tokens_saved = excluded.rtk_estimated_tokens_saved,
    rtk_filters = excluded.rtk_filters`;

export function createUsageRepo(db: Database, nodeId: string): UsageRepo {
  /**
   * The raw row and both rollups are written together: a crash between them
   * would leave the year view, or a key's hourly counters, quietly disagreeing
   * with the log they summarize. One transaction is also one fsync, so the
   * hourly bucket costs the write path nothing beyond the row it accompanies.
   *
   * The rollups are fed from the stored row rather than from the argument, so
   * they summarize what the log actually says even where the upsert kept a
   * column the completing log did not carry.
   */
  const complete = db.transaction((log: RequestLog) => {
    db.run(COMPLETE, values(log, "done", nodeId));
    const stored = db.query<Row, [string]>("SELECT * FROM request_logs WHERE id = ?").get(log.id);
    if (stored !== null) {
      const restored = toLog(stored);
      rollupLog(db, restored);
      rollupHour(db, restored);
    }
  });

  /**
   * Retention applied to the derived counters as well as to the rows.
   *
   * Without this the rollup keeps counting requests whose rows are gone, and
   * every long window — and `doctor`'s comparison of the two — reports history
   * the log no longer holds. Buckets below the boundary go whole; the one
   * boundary hour straddles the cut, so it is recomputed from what survived
   * rather than adjusted. That is one hour of one install's traffic, not a
   * second pass over the table.
   */
  const pruneLogs = db.transaction((olderThan: number): number => {
    db.run("DELETE FROM request_logs WHERE at < ?", [olderThan]);
    const removed = db.query<{ n: number }, []>("SELECT changes() AS n").get()?.n ?? 0;
    const boundary = hourOf(olderThan);
    db.run("DELETE FROM usage_rollup WHERE hour <= ?", [boundary]);
    db.run(
      `INSERT INTO usage_rollup
         (api_key_id, hour, requests, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd)
       SELECT api_key_id, ?, COUNT(*),
              COALESCE(SUM(input_tokens), 0),
              COALESCE(SUM(output_tokens), 0),
              COALESCE(SUM(cache_read_tokens), 0),
              COALESCE(SUM(cache_write_tokens), 0),
              COALESCE(SUM(cost_usd), 0)
         FROM request_logs
        WHERE state = 'done' AND api_key_id IS NOT NULL AND at >= ? AND at < ?
        GROUP BY api_key_id`,
      [boundary, boundary * HOUR_MS, (boundary + 1) * HOUR_MS],
    );
    return removed;
  });

  return {
    async begin(log: RequestLog) {
      db.run(
        `INSERT INTO request_logs ${COLUMNS} VALUES ${PLACEHOLDERS}`,
        values(log, "pending", nodeId),
      );
    },

    async route(id, target) {
      db.run(
        `UPDATE request_logs
            SET resolved_provider = ?, resolved_model = ?, credential_id = ?
          WHERE id = ? AND state = 'pending'`,
        [target.provider, target.model, target.credentialId, id],
      );
    },

    async append(log: RequestLog) {
      complete(log);
    },

    async sweepPending(now) {
      // Own rows, or rows of a node with no live heartbeat. `NOT IN` against
      // the live set rather than a join on the dead set, because a node that
      // never wrote a heartbeat has no row to join against and is dead too.
      const stale = db
        .query<Row, [string, number]>(
          `SELECT * FROM request_logs
            WHERE state = 'pending'
              AND (node_id = ? OR node_id NOT IN (SELECT id FROM nodes WHERE seen_at > ?))`,
        )
        .all(nodeId, now - NODE_GRACE_MS)
        .map(toLog);
      for (const log of stale) {
        // Through the same path as a real completion, so the daily rollup keeps
        // agreeing with the rows it summarizes.
        //
        // Zero duration, not elapsed-since-start: nobody knows when the process
        // died, and a row pending across a weekend of downtime would otherwise
        // put two days into the mean latency of the day it started on.
        complete({ ...log, status: 499, errorCode: "interrupted", durationMs: 0 });
      }
      return stale.length;
    },

    async recent(limit: number, apiKeyId?: string) {
      // `= ?` never matches NULL, so an anonymous row falls out of a scoped read
      // on its own. That is the wanted answer and not an accident of SQL: an
      // untagged request belongs to no key, so no key may read it.
      if (apiKeyId === undefined) {
        return db
          .query<Row, [number]>("SELECT * FROM request_logs ORDER BY at DESC LIMIT ?")
          .all(limit)
          .map(toLog);
      }
      return db
        .query<Row, [string, number]>(
          "SELECT * FROM request_logs WHERE api_key_id = ? ORDER BY at DESC LIMIT ?",
        )
        .all(apiKeyId, limit)
        .map(toLog);
    },

    async sumSince(apiKeyId: string, sinceMs: number) {
      // Two reads, and neither grows with how long the install has been running.
      //
      // `sinceMs` lands inside an hour rather than on one, so the bucket holding
      // it is the only one the rollup cannot answer for: it summarizes the whole
      // hour, and the window wants part of it. Every later bucket is wholly
      // inside the window — including the current, still-filling one, because
      // the window has no upper bound and the bucket holds every committed row
      // in it. So the sum is (buckets strictly after the boundary hour) plus
      // (the rows of the boundary hour at or after the instant), which keeps the
      // exact sliding semantics the limiter is specified against while bounding
      // the scan to one hour of one key's traffic.
      const boundary = hourOf(sinceMs);
      const whole = db
        .query<SumRow, [string, number]>(
          `SELECT COALESCE(SUM(requests), 0) AS requests,
                  COALESCE(SUM(input_tokens + output_tokens
                               + cache_read_tokens + cache_write_tokens), 0) AS tokens,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd
             FROM usage_rollup
            WHERE api_key_id = ? AND hour > ?`,
        )
        .get(apiKeyId, boundary);
      // `state = 'done'` is load-bearing, not hygiene, and it is why the rollup
      // is written only on completion. A pending row carries placeholder zeros
      // where its metrics will go, so an unfiltered edge scan counts every
      // in-flight request as a request and inflates the count silently.
      const edge = db
        .query<SumRow, [string, number, number]>(
          `SELECT COUNT(*) AS requests,
                  COALESCE(SUM(input_tokens + output_tokens
                               + cache_read_tokens + cache_write_tokens), 0) AS tokens,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd
             FROM request_logs
            WHERE api_key_id = ? AND state = 'done' AND at >= ? AND at < ?`,
        )
        .get(apiKeyId, sinceMs, (boundary + 1) * HOUR_MS);
      // A key with no rows in the window is zero, never unknown: both rows
      // always come back because each query is an aggregate over no groups.
      return {
        requests: (whole?.requests ?? 0) + (edge?.requests ?? 0),
        tokens: (whole?.tokens ?? 0) + (edge?.tokens ?? 0),
        costUsd: (whole?.cost_usd ?? 0) + (edge?.cost_usd ?? 0),
      };
    },

    async sumBuckets(apiKeyId, sinceMs, grainMs) {
      type BucketRow = SumRow & { bucket: number };
      const rows =
        grainMs === HOUR_MS
          ? db
              .query<BucketRow, [string, number]>(
                `SELECT hour * ${HOUR_MS} AS bucket, requests,
                        input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
                          AS tokens,
                        cost_usd
                   FROM usage_rollup
                  WHERE api_key_id = ? AND hour >= ?`,
              )
              .all(apiKeyId, hourOf(sinceMs))
          : db
              .query<BucketRow, [number, number, string, number]>(
                `SELECT (at / ?) * ? AS bucket, COUNT(*) AS requests,
                        COALESCE(SUM(input_tokens + output_tokens
                                     + cache_read_tokens + cache_write_tokens), 0) AS tokens,
                        COALESCE(SUM(cost_usd), 0) AS cost_usd
                   FROM request_logs
                  WHERE api_key_id = ? AND state = 'done' AND at >= ?
                  GROUP BY bucket`,
              )
              .all(grainMs, grainMs, apiKeyId, sinceMs);
      return rows.map((row) => [
        row.bucket,
        { requests: row.requests, tokens: row.tokens, costUsd: row.cost_usd },
      ]);
    },

    async rebuildRollup() {
      rebuildRollup(db);
    },

    async auditRollup() {
      return auditRollup(db);
    },

    async oldestSince(apiKeyId: string, sinceMs: number) {
      // `state = 'done'` for the same reason `sumSince` carries it: a pending
      // row is a placeholder rather than a measurement, and one written a
      // moment ago would answer that this window frees nothing for a whole
      // window — the exact overstatement this query exists to replace.
      const row = db
        .query<OldestRow, [string, number]>(
          `SELECT MIN(at) AS at
             FROM request_logs
            WHERE api_key_id = ? AND state = 'done' AND at >= ?`,
        )
        .get(apiKeyId, sinceMs);
      // `MIN` over no rows is a row holding null, not an absent row. Both mean
      // the same thing here: the key has nothing retained inside the window, so
      // there is no instant to report and the caller keeps its own.
      return row?.at ?? null;
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
      const scoped = scope !== undefined;
      const bindings: SQLQueryBindings[] =
        scope === undefined ? [since, until] : [since, until, scope];

      const rows = db
        .query<Agg, SQLQueryBindings[]>(
          `SELECT ${key} AS key,
                  ${split ?? "NULL"} AS split,
                  ${MEASURES[grain]},
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                  COALESCE(SUM(${daily ? "rtk_saved_tokens" : "rtk_estimated_tokens_saved"}), 0) AS rtk_saved_tokens,
                  COALESCE(SUM(${daily ? "rtk_applied_requests" : "CASE WHEN rtk_applied = 1 THEN 1 ELSE 0 END"}), 0) AS rtk_applied_requests,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd
             FROM ${daily ? "usage_daily" : "request_logs"}
            WHERE ${daily ? "" : "state = 'done' AND "}${timeColumn} >= ? AND ${timeColumn} <= ?${scoped ? " AND api_key_id = ?" : ""}
            GROUP BY key${split === null ? "" : ", split"}
            ORDER BY requests DESC`,
        )
        .all(...bindings);

      return rows.map((r): UsageBucket => {
        const bucket: UsageBucket = {
          key: label(r.key),
          requests: r.requests,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cacheReadTokens: r.cache_read_tokens,
          cacheWriteTokens: r.cache_write_tokens,
          rtkSavedTokens: r.rtk_saved_tokens,
          rtkAppliedRequests: r.rtk_applied_requests,
          costUsd: r.cost_usd,
          errors: r.errors,
          durationMsSum: r.duration_ms_sum,
        };
        return split === null ? bucket : { ...bucket, split: label(r.split) };
      });
    },

    async prune(olderThan: number) {
      return pruneLogs(olderThan);
    },

    async pruneDaily(olderThan: number) {
      db.run("DELETE FROM usage_daily WHERE day < ?", [olderThan]);
      return db.query<{ n: number }, []>("SELECT changes() AS n").get()?.n ?? 0;
    },
  };
}
