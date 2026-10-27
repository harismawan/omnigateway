import type { RequestLog, TraceAgent } from "@omni/store/types";

/**
 * The exported record: one versioned JSON object per request row, the single
 * shape every destination encoder and the console's "preview record" read.
 * Design: docs/superpowers/specs/2026-10-24-log-export-design.md (*Record*).
 *
 * Pure and deterministic — the same row and context build byte-identical JSON,
 * so a resend after a crash is the same document. Key order is the literal
 * order below; `metadata` keys are sorted, because the two backends' JSON
 * columns do not promise to hand them back in insertion order.
 *
 * The attachment path adds `body` only when every send-time gate holds.
 * A field added here is a schema change: additive fields stay `v1`,
 * anything else is `v2`.
 */
export const RECORD_SCHEMA = "omni.request_log/v1";

export type RequestRecord = {
  body?: {
    state: "included" | "incomplete" | "omitted" | "unavailable";
    reason?: string;
    client?: { request: unknown; response: unknown };
    parts?: { request: number; response: number };
  };
  schema: typeof RECORD_SCHEMA;
  id: string;
  /** ISO 8601 UTC, millisecond precision. */
  at: string;
  completedAt: string | null;
  nodeId: string | null;
  apiKey: { id: string | null; label: string | null };
  model: { requested: string; resolved: string | null; provider: string | null };
  credentialId: string | null;
  status: number;
  errorCode: string | null;
  attempts: number;
  /** `input` is uncached input, as on the row; the four classes are disjoint. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  ttftMs: number | null;
  durationMs: number;
  degradations: string[];
  rtk: {
    applied: boolean;
    filterHits: number;
    originalCodeUnits: number;
    compressedCodeUnits: number;
    estimatedTokensSaved: number;
    filters: string[];
  };
  session: { id: string | null; turn: string | null; agent: TraceAgent | null };
  tags: string[];
  metadata: Record<string, string>;
  requestIds: { client: string | null; upstream: string | null };
};

/** Insert validated JSON spans without parsing client content into a tree. */
export function recordJson(
  record: RequestRecord,
  client?: { request: string; response: string },
): string {
  if (!client) return JSON.stringify(record);
  // body is emitted last by callers; no sentinel that client text could collide with.
  const { body, ...metadata } = record;
  return `${JSON.stringify(metadata).slice(0, -1)},"body":${JSON.stringify(body).slice(0, -1)},"client":{"request":${client.request},"response":${client.response}}}}`;
}

/**
 * What the row does not hold. `keyLabel` is looked up by the caller (the
 * worker's own key cache), never read from the store here; `nodeId` names the
 * exporting process and is `null` when the caller has none.
 */
export type RecordContext = { keyLabel: string | null; nodeId?: string };

export function buildRecord(log: RequestLog, ctx: RecordContext): RequestRecord {
  return {
    schema: RECORD_SCHEMA,
    id: log.id,
    at: new Date(log.at).toISOString(),
    completedAt: log.completedAt === null ? null : new Date(log.completedAt).toISOString(),
    nodeId: ctx.nodeId ?? null,
    // A label without a key would be the caller's stale lookup, not a fact about this row.
    apiKey: { id: log.apiKeyId, label: log.apiKeyId === null ? null : ctx.keyLabel },
    model: {
      requested: log.requestedModel,
      resolved: log.resolvedModel,
      provider: log.resolvedProvider,
    },
    credentialId: log.credentialId,
    status: log.status,
    errorCode: log.errorCode,
    attempts: log.attempts,
    tokens: {
      input: log.inputTokens,
      output: log.outputTokens,
      cacheRead: log.cacheReadTokens,
      cacheWrite: log.cacheWriteTokens,
    },
    costUsd: log.costUsd,
    ttftMs: log.ttftMs,
    durationMs: log.durationMs,
    degradations: [...log.degradations],
    rtk: {
      applied: log.rtkApplied,
      filterHits: log.rtkFilterHits,
      originalCodeUnits: log.rtkOriginalCodeUnits,
      compressedCodeUnits: log.rtkCompressedCodeUnits,
      estimatedTokensSaved: log.rtkEstimatedTokensSaved,
      filters: [...log.rtkFilters],
    },
    session: { id: log.sessionId, turn: log.turnId, agent: log.agent },
    tags: [...log.tags],
    metadata: sortedMetadata(log.traceMetadata),
    requestIds: { client: log.clientRequestId, upstream: log.upstreamRequestId },
  };
}

/**
 * A sorted copy, null-prototype like the extractor's: `__proto__` and
 * `constructor` are ordinary caller keys and must stay own data properties so
 * `JSON.stringify` writes them.
 */
function sortedMetadata(source: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const key of Object.keys(source).sort()) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
