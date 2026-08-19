import type { Dimension, Window } from "@omni/ratelimit/catalog";

/**
 * One finished request, as a plugin sees it.
 *
 * Deliberately not a `RequestLog`. This payload is handed to code authored
 * outside this repository, so it carries the fields a plugin has a reason to
 * want and nothing else: no credential id, no captured bodies, no headers, no
 * prompt or response text. Widening it is a security change on the same terms
 * as widening `LogFields`, and for the same reason — once a field is in a
 * payload crossing this boundary, every plugin that logged it has already
 * logged it.
 *
 * The four token classes are disjoint. `input` is uncached input, so summing
 * all four double-counts nothing.
 */
export type RequestCompleted = {
  requestId: string;
  apiKeyId: string;
  /**
   * Null when the request failed before routing chose one — a bad model name, a
   * rejected key. Nullable rather than blank because "no provider was reached"
   * and "a provider named the empty string" are different facts, and a plugin
   * counting per-provider totals needs to tell them apart.
   */
  provider: string | null;
  /** The resolved model, falling back to what the client asked for. */
  model: string;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  costUsd: number;
  durationMs: number;
  ok: boolean;
  /** Epoch millis the request completed. */
  at: number;
};

/**
 * A key reaching one of its own configured ceilings.
 *
 * `dimension` and `window` together are a stable identity for the limit that
 * was hit, which is what makes them usable as an edge-trigger key. Nothing
 * volatile belongs in this payload: a reset instant recomputed on every
 * evaluation turns "notify once when the ceiling is reached" into "notify on
 * every evaluation after it", which is a regression both this gateway and the
 * app this design borrows from have already shipped once.
 */
export type LimitReached = {
  apiKeyId: string;
  dimension: Dimension;
  window: Window;
  at: number;
};

export type PluginEventMap = {
  "request:completed": RequestCompleted;
  "limit:reached": LimitReached;
};

export type PluginEventName = keyof PluginEventMap;

/**
 * What a plugin receives when it declares an event capability.
 *
 * Subscription only. A plugin cannot emit, because an event here means "the
 * gateway did this" and a plugin that could forge one could make every other
 * plugin believe a request happened.
 */
export type PluginEvents = {
  onRequestCompleted?: (handler: (event: RequestCompleted) => void) => void;
  onLimitReached?: (handler: (event: LimitReached) => void) => void;
};
