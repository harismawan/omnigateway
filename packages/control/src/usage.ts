import { GatewayError } from "@omni/ir";
import type { RequestLog, Store, UsageBucket } from "@omni/store";
import { ALL, readsNothing, type Scope, scopeKey } from "./principal.ts";
import {
  dimensionSchema,
  grainSchema,
  optionalNumber,
  parseOrThrow,
  requireDimension,
} from "./schemas.ts";

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
 *
 * `scope` narrows the rows and is **not** part of `input`. The input is
 * caller-supplied and parsed; the scope is derived from a verified session.
 * Letting a scope arrive through the same door as a query parameter is how a
 * client would come to choose its own.
 */
export async function queryUsage(
  deps: { store: Store; now: () => number },
  input: UsageQueryInput,
  scope: Scope = ALL,
): Promise<UsageBucket[]> {
  const grain = parseOrThrow(grainSchema, input.grain ?? "raw");
  const groupBy = requireDimension(grain, parseOrThrow(dimensionSchema, input.groupBy ?? "model"));
  const splitBy =
    input.splitBy === undefined
      ? undefined
      : requireDimension(grain, parseOrThrow(dimensionSchema, input.splitBy));

  // Scoping the *rows* is not the same property as scoping the *columns*.
  //
  // `apiKeyId` narrows which rows are counted, and it does that correctly — but
  // the bucket key is whatever dimension the caller asked to group on, and it is
  // returned verbatim. A narrowed caller asking `groupBy=credential` therefore
  // gets its own rows back, keyed by the operator's account ids: one bucket per
  // account that served it. Nothing about the row filter prevents that, because
  // the question was never about rows.
  //
  // `credential` is the only dimension naming operator infrastructure — the rest
  // (`model`, `provider`, `apiKey`, `hour`, `day`) name either the caller's own
  // request or something already public to it, and `apiKey` under a key scope
  // can only ever produce the caller's own id.
  if (scope.kind !== "all") {
    for (const dimension of [groupBy, splitBy]) {
      if (dimension === "credential") {
        throw new GatewayError("BAD_REQUEST", "this dimension is not available on this surface");
      }
    }
  }

  // Before the store, because `scopeKey` collapses `all` and `none` to the same
  // `undefined` and one of them means every row.
  if (readsNothing(scope)) return [];

  const apiKeyId = scopeKey(scope);
  return deps.store.usage.aggregate({
    grain,
    groupBy,
    ...(splitBy === undefined ? {} : { splitBy }),
    ...(apiKeyId === undefined ? {} : { apiKeyId }),
    since: optionalNumber(input.since, 0),
    until: optionalNumber(input.until, deps.now()),
  });
}

/** Clamps a requested page size into `1..MAX_LOG_LIMIT`. */
export function logLimit(requested: string | number | undefined): number {
  const value = optionalNumber(requested, DEFAULT_LOG_LIMIT);
  return Math.floor(Math.min(Math.max(1, value), MAX_LOG_LIMIT));
}

/**
 * A page of the newest request logs, narrowed to what the scope may read.
 *
 * The limit is applied by the store *after* the filter, so a quiet key still
 * fills a page rather than being paged out by traffic it cannot see.
 */
export async function recentLogs(
  store: Store,
  requested?: string | number | undefined,
  scope: Scope = ALL,
): Promise<RequestLog[]> {
  // Same gate as `queryUsage`, and it is not redundant: `scopeKey` on a `none`
  // scope returns `undefined`, which the store reads as "every row".
  if (readsNothing(scope)) return [];
  return store.usage.recent(logLimit(requested), scopeKey(scope));
}
