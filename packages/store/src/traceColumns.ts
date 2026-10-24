import { TRACE_AGENTS, type TraceAgent } from "./types.ts";

/**
 * The trace columns of `request_logs`, read and written the same way by both
 * stores. One copy, because the parse is the contract: a stored value that is
 * malformed (hand-edited, restored from somewhere odd) reads as empty rather
 * than throwing out of a log page.
 */
export const TRACE_COLUMN_NAMES = [
  "session_id",
  "turn_id",
  "agent",
  "tags",
  "trace_metadata",
  "client_request_id",
  "upstream_request_id",
] as const;

export type TraceRow = {
  session_id: string | null;
  turn_id: string | null;
  agent: string | null;
  tags: string | null;
  trace_metadata: string | null;
  client_request_id: string | null;
  upstream_request_id: string | null;
};

export type TraceFields = {
  sessionId: string | null;
  turnId: string | null;
  agent: TraceAgent | null;
  tags: string[];
  traceMetadata: Record<string, string>;
  clientRequestId: string | null;
  upstreamRequestId: string | null;
};

const isAgent = (value: unknown): value is TraceAgent =>
  typeof value === "string" && (TRACE_AGENTS as readonly string[]).includes(value);

function parseTags(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function parseMetadata(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function readTrace(r: TraceRow): TraceFields {
  return {
    sessionId: r.session_id,
    turnId: r.turn_id,
    agent: isAgent(r.agent) ? r.agent : null,
    tags: parseTags(r.tags),
    traceMetadata: parseMetadata(r.trace_metadata),
    clientRequestId: r.client_request_id,
    upstreamRequestId: r.upstream_request_id,
  };
}

/** Bindings in {@link TRACE_COLUMN_NAMES} order. Absent fields write as empty. */
export function traceValues(log: Partial<TraceFields>): Array<string | null> {
  return [
    log.sessionId ?? null,
    log.turnId ?? null,
    log.agent ?? null,
    JSON.stringify(log.tags ?? []),
    JSON.stringify(log.traceMetadata ?? {}),
    log.clientRequestId ?? null,
    log.upstreamRequestId ?? null,
  ];
}

/**
 * The completion's `SET` fragment for the trace columns. What began keeps its
 * trace when completion carries none — the terminal catch completes with a
 * blank log — and the upstream id, known only at completion, always overwrites
 * when present. `ex` is the dialect's spelling of the conflicting row
 * (`excluded` / `EXCLUDED`).
 */
export function traceCompleteSet(ex: string): string {
  const keep = (col: string) => `${col} = COALESCE(${ex}.${col}, request_logs.${col})`;
  const keepJson = (col: string, empty: string) =>
    `${col} = CASE WHEN ${ex}.${col} = '${empty}' THEN request_logs.${col} ELSE ${ex}.${col} END`;
  return [
    keep("session_id"),
    keep("turn_id"),
    keep("agent"),
    keepJson("tags", "[]"),
    keepJson("trace_metadata", "{}"),
    keep("client_request_id"),
    keep("upstream_request_id"),
  ].join(",\n    ");
}

const SESSION_AGG = `
  session_id,
  api_key_id,
  MAX(agent) AS agent,
  MIN(at) AS first_at,
  MAX(at) AS last_at,
  COUNT(*) AS requests,
  SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failed,
  COUNT(DISTINCT turn_id) AS turns,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_write_tokens) AS cache_write_tokens,
  SUM(cost_usd) AS cost_usd`;

/** The sessions read, minus its placeholders' spelling; both stores share it. */
export function sessionsSql(
  placeholder: (index: number) => string,
  q: { apiKeyId?: string; agent?: string },
): { sql: string; extra: string[] } {
  const extra: string[] = [];
  let next = 3;
  const filters: string[] = [];
  if (q.apiKeyId !== undefined) {
    filters.push(`api_key_id = ${placeholder(next++)}`);
    extra.push(q.apiKeyId);
  }
  if (q.agent !== undefined) {
    filters.push(`agent = ${placeholder(next++)}`);
    extra.push(q.agent);
  }
  const sql = `SELECT ${SESSION_AGG}
      FROM request_logs
     WHERE state = 'done' AND session_id IS NOT NULL
       AND at >= ${placeholder(1)} AND at <= ${placeholder(2)}
       ${filters.map((f) => `AND ${f}`).join(" ")}
     GROUP BY api_key_id, session_id
     ORDER BY SUM(cost_usd) DESC, MAX(at) DESC, session_id, api_key_id
     LIMIT ${placeholder(next)}`;
  return { sql, extra };
}

export type SessionRow = {
  session_id: string;
  api_key_id: string | null;
  agent: string | null;
  first_at: number | string;
  last_at: number | string;
  requests: number | string;
  failed: number | string;
  turns: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_tokens: number | string;
  cache_write_tokens: number | string;
  cost_usd: number | string;
};

export function readSession(r: SessionRow) {
  return {
    sessionId: r.session_id,
    apiKeyId: r.api_key_id,
    agent: isAgent(r.agent) ? r.agent : null,
    firstAt: Number(r.first_at),
    lastAt: Number(r.last_at),
    requests: Number(r.requests),
    failed: Number(r.failed),
    turns: Number(r.turns),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
    costUsd: Number(r.cost_usd),
  };
}
