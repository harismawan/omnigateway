import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { ProviderId } from "@omni/ir";
import type { RtkFilterId } from "@omni/rtk";
import type {
  RequestLog,
  RequestState,
  UsageBucket,
  UsageDimension,
  UsageGrain,
  UsageQuery,
  UsageRepo,
} from "../types.ts";
import { rollupLog, startOfLocalDay } from "./rollup.ts";

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

const RTK_FILTERS = new Set<RtkFilterId>([
  "git-diff",
  "git-status",
  "git-log",
  "grep",
  "path-list",
  "numbered-read",
  "build-output",
  "test-output",
  "deduplicate-log",
  "smart-truncate",
]);

function parseRtkFilters(raw: string): RtkFilterId[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (value): value is RtkFilterId =>
            typeof value === "string" && RTK_FILTERS.has(value as RtkFilterId),
        )
      : [];
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
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  errors: number;
  duration_ms_sum: number;
};

/** An absent credential, key, or upstream model is a bucket, not a hole. */
function label(value: string | number | null): string {
  if (value === null) return "unknown";
  const text = String(value);
  return text.length === 0 ? "unknown" : text;
}

const COLUMNS = `(id, state, at, api_key_id, requested_model, resolved_provider, resolved_model,
                  credential_id, attempts, status, error_code, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens, ttft_ms, duration_ms, cost_usd,
                  degradations, rtk_applied, rtk_filter_hits, rtk_original_code_units,
                  rtk_compressed_code_units, rtk_estimated_tokens_saved, rtk_filters)`;

const PLACEHOLDERS = "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";

function values(log: RequestLog, state: RequestState): SQLQueryBindings[] {
  return [
    log.id,
    state,
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
 * to what the row already holds, because the route's terminal catch synthesises
 * a blank log and can reach a row that already began — when dispatch throws
 * rather than yielding an error event.
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

export function createUsageRepo(db: Database): UsageRepo {
  /**
   * The raw row and its rollup are written together: a crash between the two
   * would leave the year view quietly disagreeing with the log it summarizes.
   *
   * The rollup is fed from the stored row rather than from the argument, so it
   * summarizes what the log actually says even where the upsert kept a column
   * the completing log did not carry.
   */
  const complete = db.transaction((log: RequestLog) => {
    db.run(COMPLETE, values(log, "done"));
    const stored = db.query<Row, [string]>("SELECT * FROM request_logs WHERE id = ?").get(log.id);
    if (stored !== null) rollupLog(db, toLog(stored));
  });

  return {
    async begin(log: RequestLog) {
      db.run(`INSERT INTO request_logs ${COLUMNS} VALUES ${PLACEHOLDERS}`, values(log, "pending"));
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

    async sweepPending() {
      const stale = db
        .query<Row, []>("SELECT * FROM request_logs WHERE state = 'pending'")
        .all()
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

    async recent(limit: number) {
      return db
        .query<Row, [number]>("SELECT * FROM request_logs ORDER BY at DESC LIMIT ?")
        .all(limit)
        .map(toLog);
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

      const rows = db
        .query<Agg, [number, number]>(
          `SELECT ${key} AS key,
                  ${split ?? "NULL"} AS split,
                  ${MEASURES[grain]},
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd
             FROM ${daily ? "usage_daily" : "request_logs"}
            WHERE ${daily ? "" : "state = 'done' AND "}${timeColumn} >= ? AND ${timeColumn} <= ?
            GROUP BY key${split === null ? "" : ", split"}
            ORDER BY requests DESC`,
        )
        .all(since, until);

      return rows.map((r): UsageBucket => {
        const bucket: UsageBucket = {
          key: label(r.key),
          requests: r.requests,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cacheReadTokens: r.cache_read_tokens,
          cacheWriteTokens: r.cache_write_tokens,
          costUsd: r.cost_usd,
          errors: r.errors,
          durationMsSum: r.duration_ms_sum,
        };
        return split === null ? bucket : { ...bucket, split: label(r.split) };
      });
    },

    async prune(olderThan: number) {
      db.run("DELETE FROM request_logs WHERE at < ?", [olderThan]);
      return db.query<{ n: number }, []>("SELECT changes() AS n").get()?.n ?? 0;
    },

    async pruneDaily(olderThan: number) {
      db.run("DELETE FROM usage_daily WHERE day < ?", [olderThan]);
      return db.query<{ n: number }, []>("SELECT changes() AS n").get()?.n ?? 0;
    },
  };
}
