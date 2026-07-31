import type { Database } from "bun:sqlite";
import type { ProviderId } from "@omni/ir";
import type { RequestLog, UsageBucket, UsageQuery, UsageRepo } from "../types.ts";

type Row = {
  id: string;
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
};

const toLog = (r: Row): RequestLog => ({
  id: r.id,
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
});

/** Whitelisted so the groupBy value can never reach SQL as raw text. */
const GROUP_COLUMN: Readonly<Record<UsageQuery["groupBy"], string>> = {
  credential: "credential_id",
  model: "resolved_model",
  apiKey: "api_key_id",
  hour: "at / 3600000",
};

export function createUsageRepo(db: Database): UsageRepo {
  return {
    async append(log: RequestLog) {
      db.run(
        `INSERT INTO request_logs
           (id, at, api_key_id, requested_model, resolved_provider, resolved_model, credential_id,
            attempts, status, error_code, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, ttft_ms, duration_ms, cost_usd, degradations)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          log.id,
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
        ],
      );
    },

    async recent(limit: number) {
      return db
        .query<Row, [number]>("SELECT * FROM request_logs ORDER BY at DESC LIMIT ?")
        .all(limit)
        .map(toLog);
    },

    async aggregate(q: UsageQuery) {
      const col = GROUP_COLUMN[q.groupBy];
      const until = q.until ?? Number.MAX_SAFE_INTEGER;
      type Agg = {
        key: string | null;
        requests: number;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number;
        errors: number;
      };
      return db
        .query<Agg, [number, number]>(
          `SELECT ${col} AS key,
                  COUNT(*) AS requests,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd,
                  COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
             FROM request_logs
            WHERE at >= ? AND at <= ?
            GROUP BY key
            ORDER BY requests DESC`,
        )
        .all(q.since, until)
        .map(
          (r): UsageBucket => ({
            key: r.key === null ? "unknown" : String(r.key),
            requests: r.requests,
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            costUsd: r.cost_usd,
            errors: r.errors,
          }),
        );
    },

    async prune(olderThan: number) {
      db.run("DELETE FROM request_logs WHERE at < ?", [olderThan]);
      return db.query<{ n: number }, []>("SELECT changes() AS n").get()?.n ?? 0;
    },
  };
}
