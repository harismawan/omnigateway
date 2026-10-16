import {
  type Dimension,
  type LimitConfigBase,
  WINDOW_MS,
  WINDOWS,
  type Window,
} from "./catalog.ts";

export {
  DIMENSIONS,
  type Dimension,
  type LimitConfig,
  type LimitConfigBase,
  limitConfigBaseSchema,
  limitConfigSchema,
  modelOverride,
  parseLimitConfig,
  WINDOW_MS,
  WINDOWS,
  type Window,
} from "./catalog.ts";
export { SlidingWindow } from "./window.ts";

/** Usage observed inside one window, and when that window next frees a slot. */
export type WindowCounter = { used: number; resetAt: number };

export type DimensionCounters = Partial<Record<Window, WindowCounter>>;

/**
 * What the caller observed.
 *
 * The package never learns where these came from — the 1m counts are memory
 * and the long windows are a store sum plus an in-memory delta — and neither
 * fact belongs here. That split is what makes the arithmetic below testable
 * without a gateway, a store, or a clock.
 */
export type CounterSnapshot = {
  requests?: DimensionCounters;
  tokens?: DimensionCounters;
  spend?: DimensionCounters;
  /** In-flight requests for this key right now. A gauge, not a window. */
  concurrency?: number;
};

export type Violation = {
  dimension: Dimension;
  /** Null for `concurrency`, which is a gauge and has no window. */
  window: Window | null;
  limit: number;
  used: number;
  resetAt: number;
};

export type Headroom = {
  window: Window;
  limit: number;
  used: number;
  /**
   * Floored at zero. `tokens` and `spend` debit after a response completes, so
   * a key can finish a request above its ceiling by one request's worth.
   */
  remaining: number;
  resetAt: number;
};

/**
 * Per dimension, the configured window nearest exhaustion by proportion — the
 * one that will deny first. There is one header per dimension and a key may
 * have three windows in it, and reporting the shortest unconditionally would
 * show a comfortable per-minute figure to a key one request from its weekly
 * ceiling. Empty for a dimension with no configured limit, which is what makes
 * a renderer emit nothing for it rather than an invented "unlimited".
 */
export type HeadroomByDimension = Partial<Record<Dimension, Headroom>>;

export type Decision = {
  allowed: boolean;
  /** The violation reported: of `violations`, the one clearing last. */
  violation: Violation | null;
  /**
   * Every limit the request trips, unordered.
   *
   * Kept beside the one reported because a caller that can correct a reset —
   * the gateway reads a long window's true one from the store — has to choose
   * last-to-clear again over the corrected figures. A choice made on the
   * overstated ones can name a window that, corrected, frees first.
   */
  violations: readonly Violation[];
  headroom: HeadroomByDimension;
};

/** The dimensions counted over a window. `concurrency` is handled apart. */
const WINDOWED = ["requests", "tokens", "spend"] as const;

/**
 * One dimension's row of the matrix, widened enough to hold every row.
 *
 * `spend` has no `1m`, and under `exactOptionalPropertyTypes` an optional key
 * carries `undefined` in its own right, so both have to be spelled out for the
 * three rows to walk through the same loop.
 */
type WindowLimits = Partial<Record<Window, number | null | undefined>>;

/**
 * Which violation is reported when several trip at once.
 *
 * The one that clears last, because a retry hint computed from anything earlier
 * sends the client back at an instant another limit is still refusing it. Ties
 * fall to the larger overshoot and then to the order the limits were walked in,
 * so the answer is stable rather than dependent on object key order.
 */
export function lastToClear(violations: readonly Violation[]): Violation | null {
  let chosen: Violation | null = null;
  for (const candidate of violations) {
    if (chosen === null || candidate.resetAt > chosen.resetAt) {
      chosen = candidate;
      continue;
    }
    if (
      candidate.resetAt === chosen.resetAt &&
      candidate.used / candidate.limit > chosen.used / chosen.limit
    ) {
      chosen = candidate;
    }
  }
  return chosen;
}

/**
 * Judges one request against a key's limits.
 *
 * `used` is what a window already holds, before this request. A request that
 * lands the key exactly on its ceiling is therefore allowed and the next one is
 * refused, which is the behaviour the fixed-window limiter this replaces had.
 */
export function evaluate(
  config: LimitConfigBase,
  counters: CounterSnapshot,
  now: number,
): Decision {
  const violations: Violation[] = [];
  const headroom: HeadroomByDimension = {};

  for (const dimension of WINDOWED) {
    const limits: WindowLimits | undefined = config[dimension];
    if (limits === undefined) continue;
    const observed: DimensionCounters = counters[dimension] ?? {};

    let nearest: Headroom | null = null;
    for (const window of WINDOWS) {
      const limit = limits[window];
      if (limit === undefined || limit === null) continue;

      const counter = observed[window];
      const used = counter?.used ?? 0;
      // A dimension the caller has not counted yet must not deny, and its reset
      // still has to be an instant a header renderer can print.
      const resetAt = counter?.resetAt ?? now + WINDOW_MS[window];

      if (used >= limit) violations.push({ dimension, window, limit, used, resetAt });

      const entry: Headroom = {
        window,
        limit,
        used,
        remaining: Math.max(0, limit - used),
        resetAt,
      };
      if (nearest === null || used / limit > nearest.used / nearest.limit) nearest = entry;
    }
    if (nearest !== null) headroom[dimension] = nearest;
  }

  const concurrency = config.concurrency;
  if (concurrency !== undefined && concurrency !== null) {
    const used = counters.concurrency ?? 0;
    // No headroom entry: a gauge has no window to report and neither vendor
    // defines a header for it.
    if (used >= concurrency) {
      // `now` because a gauge clears when a request finishes and nobody knows
      // when that is. Better an immediate retry than an invented deadline.
      violations.push({
        dimension: "concurrency",
        window: null,
        limit: concurrency,
        used,
        resetAt: now,
      });
    }
  }

  const violation = lastToClear(violations);
  return { allowed: violation === null, violation, violations, headroom };
}

/**
 * Joins the key-wide decision with a model override's into the one a request
 * is answered with.
 *
 * The two stack, so a request is allowed only where both allow it. Of two
 * violations the one clearing last is reported, by the same rule `evaluate`
 * applies inside a scope: a `Retry-After` from the earlier one sends the client
 * back while the other scope still refuses it. Per dimension, the headroom is
 * whichever entry is nearer exhaustion by proportion, again `evaluate`'s rule
 * across windows — the header has to name the scope that will deny first.
 * Ties keep the key-wide entry, so the answer does not depend on which scope
 * the caller happened to pass second.
 */
export function combine(key: Decision, model: Decision): Decision {
  const violations = [...key.violations, ...model.violations];
  const violation = lastToClear(violations);

  const headroom: HeadroomByDimension = { ...key.headroom };
  for (const dimension of WINDOWED) {
    const candidate = model.headroom[dimension];
    if (candidate === undefined) continue;
    const current = headroom[dimension];
    if (current === undefined || candidate.used / candidate.limit > current.used / current.limit) {
      headroom[dimension] = candidate;
    }
  }
  return { allowed: violation === null, violation, violations, headroom };
}

/** How long a client should wait, never negative and zero for no violation. */
export function retryAfterMs(violation: Violation | null, now: number): number {
  return violation === null ? 0 : Math.max(0, violation.resetAt - now);
}
