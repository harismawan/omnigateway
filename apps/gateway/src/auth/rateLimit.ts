import { type Coord, memoryCoord } from "@omni/coord";
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
 * How often the idle-key sweep may run.
 *
 * One second, because the sweep only reclaims memory: a key that goes idle is
 * held at most this much longer than it was before, and the shortest window
 * this limiter serves is a minute. Anything shorter buys nothing and puts the
 * O(active keys) walk back on a meaningful share of requests.
 */
const CLEANUP_INTERVAL_MS = 1_000;

/**
 * The fraction of a ceiling past which a key stops waiting out the TTL.
 *
 * Precision rises exactly where a decision is close, and an idle key pays
 * nothing for it.
 */
const EAGER_FRACTION = 0.9;

/**
 * How long a shared gauge holds a slot for a process that never released it.
 *
 * Only a shared `Coord` reads this: an in-memory gauge dies with its process.
 * A request may legitimately run for longer — the dispatch deadline can be
 * unlimited — so this is a floor on a leaked slot's life, not a bound on a
 * request's. ponytail: one constant; renew the slot from the stream loop if
 * hour-long requests ever meet a shared gauge.
 */
const GAUGE_TTL_MS = 3_600_000;

/**
 * How many delta entries one key may hold before the oldest are folded together.
 *
 * A successful store read is what normally empties this list, so a store that
 * cannot answer leaves nothing emptying it: it grows with every completed
 * request for as long as the fault lasts, `cleanup` can never drop the key
 * because a key holding debits is not idle, and `markEager` walks the whole
 * list once per debit. See `trimDebits` for why folding rather than dropping.
 */
export const MAX_DEBITS = 10_000;

/** One completed request's contribution, held until a store read absorbs it. */
export type Debit = { at: number; requests: number; tokens: number; costUsd: number };

/** The last store read for one key, and the instant it was issued at. */
type StoreCounts = { readAt: number; sums: Record<LongWindow, UsageSums> };

/**
 * What this class still holds per key: the long-window side.
 *
 * The `1m` ring and the concurrency gauge live behind `Coord`, because they are
 * the two counters a fleet must share exactly. What is left is the store-sum
 * cache and the delta of rows debited since it was read.
 */
type KeyState = {
  /**
   * Checks sitting between claiming their place and being judged.
   *
   * A check yields on a store read, and until it returns this entry must not be
   * dropped: a suspended check recording a debit onto an orphaned entry is a
   * request counted nowhere.
   */
  deciding: number;
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

/** The far edge of the longest window, past which nothing can still be counted. */
const LONGEST_WINDOW_MS = Math.max(...LONG_WINDOWS.map((window) => WINDOW_MS[window]));

/**
 * Bounds one key's delta list without ever lowering what it reports.
 *
 * Two bounds, applied in that order, because they fail in different directions
 * and only one of them is free:
 *
 * - A debit older than the longest window is outside every window there is, so
 *   dropping it changes no count at all. This is also what lets `cleanup` drop
 *   a key that went quiet during a fault, rather than holding its entry for the
 *   life of the process.
 * - Past `MAX_DEBITS` the oldest entries are folded into one, stamped at the
 *   newest instant among them — not discarded. A dropped debit is a request
 *   counted nowhere, which is the one direction this design must never take; a
 *   folded one is counted for longer than it belonged, which is the direction
 *   `sinceRead` already chooses and for the same reason.
 *
 * Pure and exported so the second bound can be tested for what it promises,
 * which is a property of the arithmetic rather than of any store fault.
 */
export function trimDebits(debits: readonly Debit[], now: number): Debit[] {
  const live = debits.filter((debit) => debit.at >= now - LONGEST_WINDOW_MS);
  if (live.length <= MAX_DEBITS) return live;

  const folded: Debit = { at: 0, requests: 0, tokens: 0, costUsd: 0 };
  const cut = live.length - MAX_DEBITS + 1;
  for (const debit of live.slice(0, cut)) {
    folded.at = Math.max(folded.at, debit.at);
    folded.requests += debit.requests;
    folded.tokens += debit.tokens;
    folded.costUsd += debit.costUsd;
  }
  return [folded, ...live.slice(cut)];
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
 * The ring and the gauge live behind `Coord`, so a fleet shares them exactly
 * and one process holds them in memory; the long-window cache is per process
 * and reset on restart, rehydrating from the store on the next read, so a
 * restart costs at most the delta since the last one.
 */
export class ApiKeyRateLimiter {
  private readonly keys = new Map<string, KeyState>();
  private readonly coord: Coord;
  /**
   * When the sweep last ran, so it runs at most once per `CLEANUP_INTERVAL_MS`.
   *
   * `cleanup` walks every live key, and both `admit` and `consume` opened with
   * it — O(active keys) on every request, for a sweep whose only job is to free
   * memory. Gating it changes nothing about *what* is droppable: an entry that
   * becomes droppable mid-interval is dropped at the next gate instead, and
   * nothing reads a droppable entry in between — a request naming that key
   * re-uses the entry, and every other reader is holding a claim, which is
   * what makes an entry undroppable.
   *
   * Negative infinity rather than zero states "has never run" outright. It is
   * not load-bearing — at any clock value a real or injected one starts from,
   * the first call is already past the gate, and at zero the map is empty — so
   * do not expect a test to fail if it is changed.
   */
  private lastCleanup = Number.NEGATIVE_INFINITY;
  private readonly store: Store;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(deps: RateLimiterDeps) {
    this.store = deps.store;
    this.now = deps.now;
    this.logger = deps.logger ?? noopLogger;
    this.coord = deps.coord ?? memoryCoord();
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
    const claim = await this.claim(state, keyId, now, true);

    let admitted = false;
    try {
      const counters = await this.counters(state, keyId, limits, claim, now, requestId);
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
      state.deciding--;
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
    this.cleanup(now);
    const state = this.state(keyId, limits);
    const claim = await this.claim(state, keyId, now, false);

    let consumed = false;
    try {
      const counters = await this.counters(state, keyId, { requests }, claim, now, requestId);
      await this.refuse(keyId, evaluate({ requests }, counters, now), now, requestId);
      consumed = true;
    } finally {
      state.deciding--;
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
  private async claim(state: KeyState, keyId: string, now: number, gauge: boolean): Promise<Claim> {
    // Held for the length of the check, and raised before the first yield.
    // Without it `cleanup` can drop an entry that looks idle and leave a
    // suspended check recording onto an orphan, and a request counted nowhere
    // is the one error direction this design must never take.
    state.deciding++;
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
  inFlight(keyId: string): Promise<number> {
    return this.coord.gauge.read(keyId);
  }

  /**
   * Delta entries waiting for a store read to absorb them. Zero for a key
   * holding nothing.
   *
   * A store read is what empties this, so its length is a fact about how long
   * the store has been unable to answer rather than about traffic — which is
   * why `trimDebits` bounds it and why the bound is observable.
   */
  pendingDebits(keyId: string): number {
    return this.keys.get(keyId)?.debits.length ?? 0;
  }

  /**
   * Keys currently holding state, which is everything this limiter can grow.
   *
   * Exposed because the sweep that bounds it is otherwise unobservable: an
   * entry is only droppable once nothing reads it, so its removal changes no
   * other answer this class gives. That makes "the sweep still runs" a claim
   * with no behavioural witness — and the sweep is now time-gated, which is
   * exactly the kind of change that can silently turn into "never".
   */
  liveKeys(): number {
    return this.keys.size;
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

  private state(keyId: string, limits: LimitConfig): KeyState {
    const existing = this.keys.get(keyId);
    if (existing !== undefined) {
      // Limits are editable after creation, so the newest ones win; a debit
      // judges its own nearness to a ceiling against whatever was last seen.
      existing.limits = limits;
      return existing;
    }
    const created: KeyState = {
      deciding: 0,
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
   * `requests` at `1m` and `concurrency` are pure memory and come off the claim,
   * which read them the instant before this request joined them — so they
   * include every claim taken ahead of this one and never this one itself. The
   * long windows are omitted entirely when the store cannot answer, which
   * `evaluate` reads as nothing used — see `longCounts` for why that is the
   * chosen failure. They need no such correction: a long window's `requests`
   * debits on completion, so this request is not in it either.
   */
  private async counters(
    state: KeyState,
    keyId: string,
    limits: LimitConfig,
    claim: Claim,
    now: number,
    requestId: string | undefined,
  ): Promise<CounterSnapshot> {
    const requests: DimensionCounters = { "1m": claim.before.requests };
    const snapshot: CounterSnapshot = { requests, concurrency: claim.before.concurrency };
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
   *
   * There is deliberately no timeout on the reads. `bun:sqlite` is synchronous:
   * the timer that would fire cannot run until the query it is bounding has
   * returned, so a deadline here is a promise the runtime cannot keep. The
   * bound that does exist is `sumSince` reading a rollup instead of scanning a
   * window, which is flat in the size of the window.
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
        this.store.usage.sumSince(keyId, readAt - WINDOW_MS["5h"]),
        this.store.usage.sumSince(keyId, readAt - WINDOW_MS["1w"]),
      ]);
      // A read that comes back behind a newer one is discarded rather than
      // installed. Two read-throughs can be in flight at once — nothing here
      // holds a lock across the yield — and against a store whose reads settle
      // out of order the older one would overwrite the newer sums *after* the
      // newer had already pruned the debits covering the difference, so the
      // usage between the two reads would be counted in neither place. An equal
      // `readAt` still installs: both asked about the same instant, and the one
      // that resolved later saw at least as many committed rows.
      const newer = state.counts;
      if (newer !== null && newer.readAt > readAt) return newer;

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
        reason: describeError(error, "unknown"),
      });
      // Nothing absorbed the list this time, and nothing will until the store
      // answers again, so it is bounded here instead. Without this the fault
      // costs memory that only a restart gives back and turns `markEager` into
      // a walk of every request served since it began.
      state.debits = trimDebits(state.debits, now);
      return null;
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
   * anything. A key is only droppable once no check is inside it, nothing is
   * waiting to be absorbed by a store read, and its cached sums have expired
   * anyway — dropping it earlier would lose a debit or orphan the entry a
   * suspended check is still holding.
   *
   * The ring and the gauge used to be part of this condition; they live behind
   * `Coord` now, which sweeps its own drained rings, so `deciding` is what
   * keeps an entry alive across the check and nothing else does.
   */
  private cleanup(now: number): void {
    // A latch on wall-clock time, and `now` is `Date.now()` — so a backward NTP
    // step or a VM restore leaves `lastCleanup` in the future and the elapsed
    // figure negative. Comparing that against the interval alone would read as
    // "swept recently" and hold the sweep off for the whole of the step. Every
    // other piece of limiter state self-corrects under a clock step because it
    // is compared against a window; a latch does not, and turning the sweep
    // *off* is the one direction this gate must not fail in.
    const since = now - this.lastCleanup;
    if (since >= 0 && since < CLEANUP_INTERVAL_MS) return;
    this.lastCleanup = now;
    for (const [keyId, state] of this.keys) {
      if (state.deciding > 0 || state.debits.length > 0) continue;
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
