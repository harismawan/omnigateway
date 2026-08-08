import type { RequestLog, Store, UsageBucket } from "@omni/store";
import { dimensionSchema, grainSchema, parseOrThrow, requireDimension } from "./schemas.ts";

/** A single page of logs, capped so one query cannot read the whole table. */
export const MAX_LOG_LIMIT = 500;
const DEFAULT_LOG_LIMIT = 100;

export type UsageQueryInput = {
  grain?: string | undefined;
  groupBy?: string | undefined;
  splitBy?: string | undefined;
  since?: string | number | undefined;
  until?: string | number | undefined;
};

/**
 * Validates a usage query and runs it.
 *
 * Accepts the loose shape a query string produces, because both callers hand it
 * strings: the control API from a URL, the CLI from flags.
 */
export async function queryUsage(
  deps: { store: Store; now: () => number },
  input: UsageQueryInput,
): Promise<UsageBucket[]> {
  const grain = parseOrThrow(grainSchema, input.grain ?? "raw");
  const groupBy = requireDimension(grain, parseOrThrow(dimensionSchema, input.groupBy ?? "model"));
  const splitBy =
    input.splitBy === undefined
      ? undefined
      : requireDimension(grain, parseOrThrow(dimensionSchema, input.splitBy));

  const since = input.since === undefined ? 0 : Number(input.since);
  const until = input.until === undefined ? deps.now() : Number(input.until);

  return deps.store.usage.aggregate({
    grain,
    groupBy,
    ...(splitBy === undefined ? {} : { splitBy }),
    since: Number.isFinite(since) ? since : 0,
    until: Number.isFinite(until) ? until : deps.now(),
  });
}

/** Clamps a requested page size into `1..MAX_LOG_LIMIT`. */
export function logLimit(requested: string | number | undefined): number {
  const value = requested === undefined ? DEFAULT_LOG_LIMIT : Number(requested);
  if (!Number.isFinite(value)) return DEFAULT_LOG_LIMIT;
  return Math.floor(Math.min(Math.max(1, value), MAX_LOG_LIMIT));
}

export async function recentLogs(
  store: Store,
  requested?: string | number | undefined,
): Promise<RequestLog[]> {
  return store.usage.recent(logLimit(requested));
}
