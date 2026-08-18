import { GatewayError, type Logger, noopLogger } from "@omni/ir";
import {
  type CounterSnapshot,
  type Decision,
  type DimensionCounters,
  evaluate,
  type HeadroomByDimension,
  retryAfterMs,
  SlidingWindow,
} from "@omni/ratelimit";
import { type LimitConfig, WINDOW_MS, type Window } from "@omni/ratelimit/catalog";
import type { Store, UsageSums } from "@omni/store";

/**
 * The windows counted from `request_logs` rather than from memory.
 *
 * A minute of timestamps is sixty numbers and is held exactly; five hours or a
 * week of them is not, and the rows are already there.
 */
const LONG_WINDOWS = ["5h", "1w"] as const;

type LongWindow = (typeof LONG_WINDOWS)[number];

/**
 * How long a store sum is reused before it is read again.
 *
 * The bound on how stale a long-window count may be, and therefore on how far
 * it may run high — see `sinceRead` for why it can only run high.
 */
const CACHE_TTL_MS = 30_000;

/**
 * The fraction of a ceiling past which a key stops waiting out the TTL.
 *
 * Precision rises exactly where a decision is close, and an idle key pays
 * nothing for it.
 */
const EAGER_FRACTION = 0.9;

/**
 * How long a single `sumSince` may take before the request is served without
 * it. On the hot path of every request, so a store that has stopped answering
 * must not become a gateway that has stopped answering.
 */
const SUM_TIMEOUT_MS = 1_000;

/** One completed request's contribution, held until a store read absorbs it. */
type Debit = { at: number; requests: number; tokens: number; costUsd: number };

/** The last store read for one key, and the instant it was issued at. */
type StoreCounts = { readAt: number; sums: Record<LongWindow, UsageSums> };

type KeyState = {
  /** Exact `requests` at `1m`. A ring, because a ring at this size is free. */
  ring: SlidingWindow;
  /** In-flight requests for this key right now. A gauge, not a window. */
  inFlight: number;
  debits: Debit[];
  counts: StoreCounts | null;
  /** Set by a debit that lands near a ceiling; forces the next read through. */
  stale: boolean;
  /** The limits last seen at admission, so a debit can judge its own nearness. */
  limits: LimitConfig;
};

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
  /** Overridden by tests that assert the fail-open path without waiting. */
  sumTimeoutMs?: number;
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
 * What has been debited since a store read was issued.
 *
 * `>=` rather than `>` on purpose. A row committed while the read was in flight
 * lands in both the sum and this delta and is counted twice; the alternative
 * boundary drops it from both, which is the one error this composition must
 * never make. Over-counting denies a key early, which an operator can see and
 * raise; under-counting lets a key past a ceiling by timing the refresh, which
 * an attacker can discover and an operator cannot.
 */
function sinceRead(debits: readonly Debit[], readAt: number): UsageSums {
  let requests = 0;
  let tokens = 0;
  let costUsd = 0;
  for (const debit of debits) {
    if (debit.at < readAt) continue;
    requests += debit.requests;
    tokens += debit.tokens;
    costUsd += debit.costUsd;
  }
  return { requests, tokens, costUsd };
}

/**
 * Every dimension and every window of one key's limits, counted per process.
 *
 * The arithmetic lives in `@omni/ratelimit`, which holds no state and no clock;
 * the counters live here, because a counter is state. This class is the half
 * that knows where a number came from: `requests` at `1m` from an exact ring,
 * the long windows from `usage.sumSince` plus everything debited since that
 * read, and `concurrency` from a gauge raised at admission and lowered at the
 * true end of the request.
 *
 * Process-local, and reset on restart. For `concurrency` that is correct rather
 * than a compromise — in-flight requests die with the process, so a surviving
 * count would be the bug — and the long windows rehydrate from the store on the
 * next read, so a restart costs at most the delta since the last one.
 */
export class ApiKeyRateLimiter {
  private readonly keys = new Map<string, KeyState>();
  private readonly store: Store;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly sumTimeoutMs: number;

  constructor(deps: RateLimiterDeps) {
    this.store = deps.store;
    this.now = deps.now;
    this.logger = deps.logger ?? noopLogger;
    this.sumTimeoutMs = deps.sumTimeoutMs ?? SUM_TIMEOUT_MS;
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
    this.cleanup(now);
    const state = this.state(keyId, limits);
    const counters = await this.counters(state, keyId, limits, now, requestId);
    const decision = evaluate(limits, counters, now);
    await this.refuse(keyId, decision, now, requestId);

    state.ring.record(now);
    state.inFlight++;

    let released = false;
    // Closed over the state rather than looked up again, so a release that
    // arrives after the entry was dropped lowers the count it raised instead of
    // one belonging to a fresh entry. `cleanup` never drops a state that is
    // holding a request, so the two cannot disagree about a live key.
    const release = () => {
      if (released) return;
      released = true;
      state.inFlight = Math.max(0, state.inFlight - 1);
    };
    return { release, headroom: decision.headroom };
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
    this.cleanup(now);
    const state = this.state(keyId, limits);
    const counters = await this.counters(state, keyId, { requests }, now, requestId);
    await this.refuse(keyId, evaluate({ requests }, counters, now), now, requestId);

    state.ring.record(now);
  }

  /**
   * Records one completed request against the long windows.
   *
   * Called from `finishLog`, beside the `usage.append` that writes the row, so
   * it inherits that site's at-most-once-per-request-id guarantee rather than
   * needing a second one. It stays outside `@omni/store`: store rows live
   * behind that package and the store has no business knowing a gateway
   * limiter exists.
   *
   * `requests` is debited here rather than at admission because the store sum
   * counts finished rows only, and a delta entry pruned before its row was
   * committed would leave the request counted nowhere.
   */
  debit(keyId: string, usage: { tokens: number; costUsd: number }): void {
    const state = this.keys.get(keyId);
    // A key this process never admitted has nothing in memory to correct, and
    // its row is already written, so the next store read counts it.
    if (state === undefined) return;
    if (!anyLongLimit(state.limits)) return;
    state.debits.push({
      at: this.now(),
      requests: 1,
      tokens: usage.tokens,
      costUsd: usage.costUsd,
    });
    this.markEager(state);
  }

  /** In-flight requests for one key. Zero for a key holding nothing. */
  inFlight(keyId: string): number {
    return this.keys.get(keyId)?.inFlight ?? 0;
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

    // A denied request records nothing: the ring is not advanced and the gauge
    // is not raised, so a key hammering its own ceiling does not push itself
    // further past it.
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
      // Never behind now: a row on the very edge of the window ages out as this
      // is read, and a reset in the past is a `Retry-After` of zero dressed up.
      return Math.max(now, oldest + length);
    } catch (error) {
      this.logger.warn("rate limit reset unavailable", {
        ...(requestId === undefined ? {} : { requestId }),
        apiKeyId: keyId,
        // The message only, for the same reason the counter read logs only the
        // message: a store failure must not drag a row's contents into stdout.
        reason: error instanceof Error ? error.message : "unknown",
      });
      return null;
    }
  }

  private state(keyId: string, limits: LimitConfig): KeyState {
    const existing = this.keys.get(keyId);
    if (existing !== undefined) {
      // Limits are editable after creation, so the newest ones win; a debit
      // judges its own nearness to a ceiling against whatever was last seen.
      existing.limits = limits;
      return existing;
    }
    const created: KeyState = {
      ring: new SlidingWindow(WINDOW_MS["1m"]),
      inFlight: 0,
      debits: [],
      counts: null,
      stale: false,
      limits,
    };
    this.keys.set(keyId, created);
    return created;
  }

  /**
   * Assembles what this key has used, from the two sources that know.
   *
   * `requests` at `1m` and `concurrency` are pure memory and are always here.
   * The long windows are omitted entirely when the store cannot answer, which
   * `evaluate` reads as nothing used — see `longCounts` for why that is the
   * chosen failure.
   */
  private async counters(
    state: KeyState,
    keyId: string,
    limits: LimitConfig,
    now: number,
    requestId: string | undefined,
  ): Promise<CounterSnapshot> {
    const requests: DimensionCounters = {
      "1m": { used: state.ring.count(now), resetAt: state.ring.resetAt(now) },
    };
    const snapshot: CounterSnapshot = { requests, concurrency: state.inFlight };
    if (!anyLongLimit(limits)) return snapshot;

    const counts = await this.longCounts(state, keyId, now, requestId);
    if (counts === null) return snapshot;

    const tokens: DimensionCounters = {};
    const spend: DimensionCounters = {};
    const delta = sinceRead(state.debits, counts.readAt);
    for (const window of LONG_WINDOWS) {
      const sums = counts.sums[window];
      // The far end of the window. The instant a long window actually frees a
      // slot is the oldest retained row's timestamp plus its length, which is a
      // second query on every request; this over-states the wait rather than
      // sending a client back at an instant the limit is still refusing it.
      const resetAt = now + WINDOW_MS[window];
      requests[window] = { used: sums.requests + delta.requests, resetAt };
      tokens[window] = { used: sums.tokens + delta.tokens, resetAt };
      spend[window] = { used: sums.costUsd + delta.costUsd, resetAt };
    }
    snapshot.tokens = tokens;
    snapshot.spend = spend;
    return snapshot;
  }

  /**
   * The cached store sums, read through when they are stale or missing.
   *
   * Null where the read failed, which serves the request. The reasoning is
   * proportionality: this is a self-hosted gateway, and a transient store fault
   * that 429s all traffic is a worse outage than briefly under-enforcing a
   * weekly budget. The limits that stop abuse fastest — `requests` at `1m` and
   * `concurrency` — are pure memory and keep enforcing exactly through the
   * fault, because they never reach this function.
   */
  private async longCounts(
    state: KeyState,
    keyId: string,
    now: number,
    requestId: string | undefined,
  ): Promise<StoreCounts | null> {
    const cached = state.counts;
    if (cached !== null && !state.stale && now - cached.readAt < CACHE_TTL_MS) return cached;

    // Captured before the reads are issued and never after: everything recorded
    // from this instant on stays in the delta, so a row committed while a read
    // was in flight is counted twice rather than lost between the two.
    const readAt = now;
    try {
      const [fiveHour, oneWeek] = await Promise.all([
        this.read(keyId, readAt - WINDOW_MS["5h"]),
        this.read(keyId, readAt - WINDOW_MS["1w"]),
      ]);
      state.counts = { readAt, sums: { "5h": fiveHour, "1w": oneWeek } };
      state.stale = false;
      // Anything debited before the read was issued is in the sums now, and
      // holding it in both would keep inflating the count for as long as the
      // key stayed busy.
      state.debits = state.debits.filter((debit) => debit.at >= readAt);
      return state.counts;
    } catch (error) {
      this.logger.warn("rate limit counters unavailable", {
        ...(requestId === undefined ? {} : { requestId }),
        apiKeyId: keyId,
        // The message only. A store failure must not drag a row's contents,
        // let alone a key, into stdout.
        reason: error instanceof Error ? error.message : "unknown",
      });
      return null;
    }
  }

  /** One `sumSince`, bounded so a store that never answers cannot hang a request. */
  private async read(keyId: string, since: number): Promise<UsageSums> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("usage sum timed out")), this.sumTimeoutMs);
    });
    try {
      return await Promise.race([this.store.usage.sumSince(keyId, since), expiry]);
    } finally {
      // Cleared on both outcomes, so a served request leaves no timer and a
      // timed-out one leaves no second rejection to go unhandled.
      clearTimeout(timer);
    }
  }

  /**
   * Marks the cache for read-through when a debit lands the key near a ceiling.
   *
   * The TTL is what keeps an idle key from costing a query per request, but it
   * is also thirty seconds of blindness, and blindness only matters where a
   * decision is close. A key inside the last tenth of any long-window ceiling
   * buys the precision it is about to need; every other key buys nothing.
   */
  private markEager(state: KeyState): void {
    const counts = state.counts;
    if (counts === null || state.stale) return;
    const delta = sinceRead(state.debits, counts.readAt);
    for (const window of LONG_WINDOWS) {
      const sums = counts.sums[window];
      if (
        near(state.limits.requests?.[window], sums.requests + delta.requests) ||
        near(state.limits.tokens?.[window], sums.tokens + delta.tokens) ||
        near(state.limits.spend?.[window], sums.costUsd + delta.costUsd)
      ) {
        state.stale = true;
        return;
      }
    }
  }

  /**
   * Drops keys holding nothing, so a key that stopped calling stops costing
   * anything. A key is only droppable once its ring has drained, its gauge is
   * empty, nothing is waiting to be absorbed by a store read, and its cached
   * sums have expired anyway — dropping it earlier would either lose a debit or
   * strand a release.
   */
  private cleanup(now: number): void {
    for (const [keyId, state] of this.keys) {
      state.ring.count(now);
      if (!state.ring.empty || state.inFlight > 0 || state.debits.length > 0) continue;
      if (state.counts !== null && now - state.counts.readAt < CACHE_TTL_MS) continue;
      this.keys.delete(keyId);
    }
  }
}

/** Whether an observed figure has reached the eager-refresh fraction of a limit. */
function near(limit: number | null | undefined, used: number): boolean {
  return configured(limit) && used >= limit * EAGER_FRACTION;
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
