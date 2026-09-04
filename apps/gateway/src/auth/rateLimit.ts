import { type Coord, type Counts, LockUnavailable, memoryCoord } from "@omni/coord";
import { describeError, GatewayError, type Logger, noopLogger } from "@omni/ir";
import {
  type CounterSnapshot,
  type Decision,
  type DimensionCounters,
  evaluate,
  type HeadroomByDimension,
  retryAfterMs,
  type WindowCounter,
} from "@omni/ratelimit";
import { type Dimension, type LimitConfig, WINDOW_MS, type Window } from "@omni/ratelimit/catalog";
import type { Store } from "@omni/store";

/**
 * The windows counted in shared time buckets rather than in the ring.
 *
 * A minute of timestamps is sixty numbers and is held exactly; five hours or a
 * week of them is not. Those are summed from `Coord.buckets`, one bucket per
 * grain, seeded from the store the first time a key is asked about.
 */
const LONG_WINDOWS = ["5h", "1w"] as const;

type LongWindow = (typeof LONG_WINDOWS)[number];

/**
 * How finely each long window slides.
 *
 * A window is the sum of its live buckets and over-counts by at most one
 * bucket at its trailing edge: a minute of a five-hour window, an hour of a
 * week. Finer than the thirty-second store cache this replaced, and in the one
 * direction the composition may err — see `evaluate` for why high is the safe
 * side. The hour grain is also `usage_rollup`'s own, so a week seeds from the
 * rollup in one flat read.
 */
const GRAIN_MS: Record<LongWindow, number> = { "5h": 60_000, "1w": 3_600_000 };

/** How long one seed may hold the seed lock, and how long a second asker waits. */
const SEED_LOCK_MS = 5_000;

/**
 * How long a gauge holds a slot for a process that never released it.
 *
 * A slot leaks when its process dies mid-request, and when a release lands on
 * the memory fallback because the coordinator faulted between acquire and
 * release; either way the key is locked out for this long. Five minutes: past
 * the default request deadline, short enough that a fault is not an hour of
 * refusals on a `concurrency: 1` key. A request that runs longer frees its
 * slot early and admits one more, which is the direction the limiter permits.
 * ponytail: one constant; renew the slot from the stream loop if hour-long
 * requests ever meet a shared gauge.
 */
const GAUGE_TTL_MS = 300_000;

/** Where a key's long-window buckets live: `lim:<keyId>:<window>`. */
function bucketKey(keyId: string, window: LongWindow): string {
  return `lim:${keyId}:${window}`;
}

/**
 * What an admitted request carries away from the check.
 *
 * The release is the concurrency slot; the headroom is what the response's
 * rate-limit headers are rendered from. Both come from the one evaluation, so a
 * route never asks the limiter a second question about a decision it already
 * made.
 */
export type Admission = { release: () => void; headroom: HeadroomByDimension };

/**
 * One request's place in a key's counters, taken before the check could yield.
 *
 * The claim is the mechanism: two checks running at once see each other's claim
 * instead of judging the same pre-burst snapshot, which is what a check that
 * recorded only after its store read could never do.
 *
 * `before` is what the counters held the instant before the claim was taken.
 * `evaluate` judges `used` as what a limit held *before* the request being
 * judged — the boundary that admits the request landing exactly on a ceiling and
 * refuses the next — so the check is handed these figures rather than re-reading
 * state that now counts itself.
 */
type Claim = {
  /** The ring stamp that was recorded, and therefore the one to give back. */
  stamp: number;
  /** Whether the gauge was raised. `consume` claims a ring slot and nothing else. */
  gauge: boolean;
  before: { requests: WindowCounter; concurrency: number };
};

/**
 * A refusal that carries what the client is owed about it.
 *
 * A bare `GatewayError` reaches the route with a retry hint and nothing to
 * render headers from, and the headroom is known at exactly one place — the
 * evaluation that refused. `code` is still `RATE_LIMIT`, so every site that
 * matches on the code is unaffected by this being a subclass.
 */
export class RateLimitExceeded extends GatewayError {
  readonly headroom: HeadroomByDimension;

  constructor(retryAfterMs: number, headroom: HeadroomByDimension) {
    super("RATE_LIMIT", "API key rate limit exceeded", { retryAfterMs });
    this.headroom = headroom;
  }
}

export type RateLimiterDeps = {
  store: Store;
  now: () => number;
  logger?: Logger;
  /** Where the `1m` ring and the gauge live. In-memory when absent. */
  coord?: Coord;
  /** Process-local observability hook, called only for a refused decision. */
  onRejected?: (dimension: Dimension, window: Window | null) => void;
};

/** A configured ceiling, as opposed to an absent one or an explicit `null`. */
function configured(limit: number | null | undefined): limit is number {
  return limit !== undefined && limit !== null;
}

/** Whether any `requests` window is limited. */
function anyRequestLimit(limits: LimitConfig): boolean {
  for (const window of ["1m", "5h", "1w"] as const) {
    if (configured(limits.requests?.[window])) return true;
  }
  return false;
}

/** Whether anything at all is limited, so an unlimited key can allocate nothing. */
function anyLimit(limits: LimitConfig): boolean {
  if (configured(limits.concurrency) || anyRequestLimit(limits)) return true;
  for (const window of ["1m", "5h", "1w"] as const) {
    if (configured(limits.tokens?.[window])) return true;
  }
  return configured(limits.spend?.["5h"]) || configured(limits.spend?.["1w"]);
}

/** Whether any long window is configured, so a store read is worth issuing. */
function anyLongLimit(limits: LimitConfig): boolean {
  for (const window of LONG_WINDOWS) {
    if (configured(limits.requests?.[window])) return true;
    if (configured(limits.tokens?.[window])) return true;
    if (configured(limits.spend?.[window])) return true;
  }
  return false;
}

/**
 * Every dimension and every window of one key's limits.
 *
 * The arithmetic lives in `@omni/ratelimit`, which holds no state and no clock;
 * the counters live behind `Coord`, because a counter is state and a fleet
 * must share it. This class is the half that knows where a number came from:
 * `requests` at `1m` from an exact ring, `concurrency` from a gauge raised at
 * admission and lowered at the true end of the request, and the long windows
 * from time buckets that every process debits into and that are seeded from
 * the store the first time a key is asked about.
 *
 * The store stays the truth. Buckets are a picture of it that every completed
 * request updates in place, and a picture nothing holds — a fresh process, a
 * coordinator that restarted, a key idle past its window — is rebuilt from
 * `sumBuckets` under a lock so one process pays the read.
 */
export class ApiKeyRateLimiter {
  /**
   * The limits last seen at admission, so a debit knows whether a long window
   * is configured at all. ponytail: never pruned; bounded by the keys an
   * operator has minted, which is dozens.
   */
  private readonly limits = new Map<string, LimitConfig>();
  private readonly coord: Coord;
  private readonly store: Store;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly onRejected: ((dimension: Dimension, window: Window | null) => void) | undefined;

  constructor(deps: RateLimiterDeps) {
    this.store = deps.store;
    this.now = deps.now;
    this.logger = deps.logger ?? noopLogger;
    this.coord = deps.coord ?? memoryCoord();
    this.onRejected = deps.onRejected;
  }

  /**
   * Judges a request that will be dispatched, and claims its concurrency slot.
   *
   * Returns the release for that slot. It is idempotent, and it must be called
   * at the true end of the request rather than when the response head is sent:
   * a gauge is expired by nothing, so a leak locks the key out permanently and
   * says nothing while it does.
   */
  async admit(keyId: string, limits: LimitConfig, requestId?: string): Promise<Admission> {
    // An unlimited key allocates nothing, so an install that sets no limits
    // pays no memory for the mechanism — and renders no headers, because there
    // is no ceiling to report a distance from.
    if (!anyLimit(limits)) return { release: () => {}, headroom: {} };

    const now = this.now();
    this.limits.set(keyId, limits);
    const claim = await this.claim(keyId, now, true);

    let admitted = false;
    try {
      const counters = await this.counters(keyId, limits, claim, now, requestId);
      const decision = evaluate(limits, counters, now);
      await this.refuse(keyId, decision, now, requestId);
      admitted = true;

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        void this.coord.gauge.release(keyId);
      };
      return { release, headroom: decision.headroom };
    } finally {
      // Where the claim stops being provisional. An admitted request keeps it
      // until its release; anything else — a refusal, or a failure while judging
      // — gives every part of it back, because no window expires a gauge and a
      // slot leaked here locks the key out permanently and silently.
      if (!admitted) await this.rollback(keyId, claim);
    }
  }

  /**
   * Judges a `count_tokens` request, which consumes `requests` and nothing else.
   *
   * It performs no dispatch, so it consumes no upstream tokens and costs
   * nothing; charging it against a token budget would bill an operator for an
   * estimate this process computed itself. It holds nothing open either, so it
   * neither raises the concurrency gauge nor is judged against it.
   */
  async consume(keyId: string, limits: LimitConfig, requestId?: string): Promise<void> {
    const requests = limits.requests;
    if (requests === undefined || !anyRequestLimit(limits)) return;

    const now = this.now();
    this.limits.set(keyId, limits);
    const claim = await this.claim(keyId, now, false);

    let consumed = false;
    try {
      const counters = await this.counters(keyId, { requests }, claim, now, requestId);
      await this.refuse(keyId, evaluate({ requests }, counters, now), now, requestId);
      consumed = true;
    } finally {
      if (!consumed) await this.rollback(keyId, claim);
    }
  }

  /**
   * Takes this request's place in the counters, and reports what they held
   * before it did.
   *
   * Recorded before the caller can yield on its store read: that is the whole
   * mechanism. A check that recorded only after that read let every concurrent
   * check judge the same pre-burst snapshot, so ten requests arriving together
   * against a ceiling of three were ten admissions — and the same for the
   * gauge, which is the dimension that is supposed to bound exactly that
   * burst. `Coord` promises each claim is visible the instant the call is
   * made, so the `await`s here yield after the record, never before it.
   */
  private async claim(keyId: string, now: number, gauge: boolean): Promise<Claim> {
    const ring = await this.coord.window.claim(keyId, WINDOW_MS["1m"], now);
    const concurrency = gauge
      ? await this.coord.gauge.acquire(keyId, GAUGE_TTL_MS)
      : await this.coord.gauge.read(keyId);
    return { stamp: ring.stamp, gauge, before: { requests: ring.before, concurrency } };
  }

  /** Gives back every part of a claim, for a request that will not be served. */
  private async rollback(keyId: string, claim: Claim): Promise<void> {
    await this.coord.window.rollback(keyId, claim.stamp);
    if (claim.gauge) await this.coord.gauge.release(keyId);
  }

  /**
   * Records one completed request against the long windows.
   *
   * Called from `finishLog`, beside the `usage.append` that writes the row, so
   * it inherits that site's at-most-once-per-request-id guarantee rather than
   * needing a second one. Row first, then this: a key nothing has seeded
   * ignores the debit, and the seed that follows reads the row instead.
   *
   * `requests` is debited here rather than at admission because the store sum
   * counts finished rows only, and the buckets must agree with what a seed
   * would read.
   */
  debit(keyId: string, usage: { tokens: number; costUsd: number }): void {
    const limits = this.limits.get(keyId);
    // A key this process never admitted has nothing to add to: its row is
    // written, and whoever seeds the key next counts it.
    if (limits === undefined || !anyLongLimit(limits)) return;
    const now = this.now();
    const delta = { requests: 1, tokens: usage.tokens, costUsd: usage.costUsd };
    for (const window of LONG_WINDOWS) {
      void this.coord.buckets.add(
        bucketKey(keyId, window),
        GRAIN_MS[window],
        WINDOW_MS[window],
        now,
        delta,
      );
    }
  }

  /** In-flight requests for one key. Zero for a key holding nothing. */
  inFlight(keyId: string): Promise<number> {
    return this.coord.gauge.read(keyId);
  }

  private async refuse(
    keyId: string,
    decision: Decision,
    now: number,
    requestId: string | undefined,
  ): Promise<void> {
    const violation = decision.violation;
    if (violation === null) return;

    // The one read this design makes on the refusal path and nowhere else. Null
    // for a violation with no window, which is why the correction below is
    // guarded on the window rather than on the instant.
    const window = violation.window;
    const exact = await this.exactReset(keyId, window, now, requestId);
    const resolved = exact === null ? violation : { ...violation, resetAt: exact };
    const headroom =
      exact === null || window === null
        ? decision.headroom
        : withReset(decision.headroom, window, exact);

    // A denied request keeps nothing: its caller rolls back the ring stamp and
    // the gauge slot the check claimed before it ran, so a key hammering its own
    // ceiling does not push itself further past it.
    try {
      this.onRejected?.(violation.dimension, violation.window);
    } catch {
      // Observability cannot turn a refusal into a different failure.
    }
    throw new RateLimitExceeded(retryAfterMs(resolved, now), headroom);
  }

  /**
   * When a long window truly frees a slot, asked only of a request being
   * refused.
   *
   * `counters` reports a long window's reset as `now + windowMs`, because the
   * instant it actually releases anything is the oldest retained row's
   * timestamp plus the window's length and that is a second query on every
   * request. Overstating is the safe direction while a request is being served,
   * since nothing acts on it. A `Retry-After` is acted on: a client one request
   * over a weekly ceiling would be told to stop for seven days when a slot may
   * free in an hour, and a well-behaved SDK would obey.
   *
   * Null wherever there is nothing better to say, which the caller reads as
   * "keep the overstated figure":
   *
   * - `concurrency` has no window, and nobody knows when a request will finish.
   * - `1m` is already exact — the ring holds every timestamp in it.
   * - A window holding no completed row has no instant to report.
   * - A failed read. The request is already being refused, and a reset that
   *   could not be computed must not turn a 429 into a 500.
   */
  private async exactReset(
    keyId: string,
    window: Window | null,
    now: number,
    requestId: string | undefined,
  ): Promise<number | null> {
    if (window === null || window === "1m") return null;
    const length = WINDOW_MS[window];
    try {
      const oldest = await this.store.usage.oldestSince(keyId, now - length);
      if (oldest === null) return null;
      // No clamp to `now`. `oldestSince` was asked for rows at or after
      // `now - length`, so `oldest + length >= now` by construction, and `now`
      // is a fixed local rather than a second clock read — there is no instant
      // at which this can come back in the past. A guard here would describe a
      // race the code cannot have, which is what `SUM_TIMEOUT_MS` did before it
      // was deleted for the same reason.
      return oldest + length;
    } catch (error) {
      this.logger.warn("rate limit reset unavailable", {
        ...(requestId === undefined ? {} : { requestId }),
        apiKeyId: keyId,
        // The message only, for the same reason the counter read logs only the
        // message: a store failure must not drag a row's contents into stdout.
        reason: describeError(error, "unknown"),
      });
      return null;
    }
  }

  /**
   * Assembles what this key has used, from the two sources that know.
   *
   * `requests` at `1m` and `concurrency` come off the claim, which read them
   * the instant before this request joined them — so they include every claim
   * taken ahead of this one and never this one itself. The long windows are
   * omitted entirely when neither the coordinator nor the store can answer,
   * which `evaluate` reads as nothing used — see `longCounts` for why that is
   * the chosen failure. They need no such correction: a long window's
   * `requests` debits on completion, so this request is not in it either.
   */
  private async counters(
    keyId: string,
    limits: LimitConfig,
    claim: Claim,
    now: number,
    requestId: string | undefined,
  ): Promise<CounterSnapshot> {
    const requests: DimensionCounters = { "1m": claim.before.requests };
    const snapshot: CounterSnapshot = { requests, concurrency: claim.before.concurrency };
    if (!anyLongLimit(limits)) return snapshot;

    const counts = await this.longCounts(keyId, now, requestId);
    if (counts === null) return snapshot;

    const tokens: DimensionCounters = {};
    const spend: DimensionCounters = {};
    for (const window of LONG_WINDOWS) {
      const sums = counts[window];
      // The far end of the window. The instant a long window actually frees a
      // slot is the oldest retained row's timestamp plus its length, which is a
      // second query on every request; this over-states the wait rather than
      // sending a client back at an instant the limit is still refusing it.
      const resetAt = now + WINDOW_MS[window];
      requests[window] = { used: sums.requests, resetAt };
      tokens[window] = { used: sums.tokens, resetAt };
      spend[window] = { used: sums.costUsd, resetAt };
    }
    snapshot.tokens = tokens;
    snapshot.spend = spend;
    return snapshot;
  }

  /**
   * Both long windows, summed from the buckets and seeded where there are none.
   *
   * Null where the store could not seed, which serves the request. The
   * reasoning is proportionality: this is a self-hosted gateway, and a
   * transient store fault that 429s all traffic is a worse outage than briefly
   * under-enforcing a weekly budget. The limits that stop abuse fastest —
   * `requests` at `1m` and `concurrency` — never reach the store, and keep
   * enforcing exactly through the fault.
   *
   * There is deliberately no timeout on the seed read. `bun:sqlite` is
   * synchronous: the timer that would fire cannot run until the query it is
   * bounding has returned, so a deadline here is a promise the runtime cannot
   * keep.
   */
  private async longCounts(
    keyId: string,
    now: number,
    requestId: string | undefined,
  ): Promise<Record<LongWindow, Counts> | null> {
    const out = {} as Record<LongWindow, Counts>;
    for (const window of LONG_WINDOWS) {
      const key = bucketKey(keyId, window);
      const grain = GRAIN_MS[window];
      const length = WINDOW_MS[window];
      let sum = await this.coord.buckets.sum(key, grain, length, now);
      if (sum === null) {
        try {
          sum = await this.seed(keyId, window, now);
        } catch (error) {
          this.logger.warn("rate limit counters unavailable", {
            ...(requestId === undefined ? {} : { requestId }),
            apiKeyId: keyId,
            // The message only. A store failure must not drag a row's
            // contents, let alone a key, into stdout.
            reason: describeError(error, "unknown"),
          });
          return null;
        }
      }
      out[window] = sum;
    }
    return out;
  }

  /**
   * Rebuilds one window's buckets from the store, under a lock so that a
   * fleet asking about the same key at once pays one read.
   *
   * Re-checked inside the lock: the process that waited finds the picture the
   * holder installed and returns it. A lock that cannot be taken seeds
   * anyway — two seeds install the same picture, and the alternative is a
   * request refused over a coordination fault.
   */
  private async seed(keyId: string, window: LongWindow, now: number): Promise<Counts> {
    const key = bucketKey(keyId, window);
    const grain = GRAIN_MS[window];
    const length = WINDOW_MS[window];
    const install = async (): Promise<Counts> => {
      const already = await this.coord.buckets.sum(key, grain, length, now);
      if (already !== null) return already;
      const rows = await this.store.usage.sumBuckets(keyId, now - length, grain);
      await this.coord.buckets.seed(key, grain, length, now, rows);
      return (await this.coord.buckets.sum(key, grain, length, now)) ?? zero();
    };
    try {
      return await this.coord.mutex.withLock(`seed:${key}`, SEED_LOCK_MS, SEED_LOCK_MS, install);
    } catch (error) {
      if (!(error instanceof LockUnavailable)) throw error;
      return install();
    }
  }
}

function zero(): Counts {
  return { requests: 0, tokens: 0, costUsd: 0 };
}

/**
 * Rewrites the reset of every reported dimension sitting on one window.
 *
 * So the headers on a 429 name the same instant as the `Retry-After` beside
 * them. A response that says "wait an hour" in one field and "wait a week" in
 * the next is worse than either figure alone: the client obeys whichever its
 * SDK happens to read.
 */
function withReset(
  headroom: HeadroomByDimension,
  window: Window,
  resetAt: number,
): HeadroomByDimension {
  const corrected: HeadroomByDimension = { ...headroom };
  for (const dimension of ["requests", "tokens", "spend"] as const) {
    const entry = corrected[dimension];
    if (entry !== undefined && entry.window === window)
      corrected[dimension] = { ...entry, resetAt };
  }
  return corrected;
}
