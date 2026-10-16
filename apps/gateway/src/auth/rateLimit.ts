import { type Coord, type Counts, LockUnavailable, memoryCoord } from "@omni/coord";
import { describeError, GatewayError, type Logger, noopLogger } from "@omni/ir";
import {
  type CounterSnapshot,
  combine,
  type Decision,
  type DimensionCounters,
  evaluate,
  type HeadroomByDimension,
  lastToClear,
  retryAfterMs,
  type WindowCounter,
} from "@omni/ratelimit";
import {
  type Dimension,
  type LimitConfig,
  type LimitConfigBase,
  modelOverride,
  WINDOW_MS,
  type Window,
} from "@omni/ratelimit/catalog";
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
 * How long a concurrency slot is held before it must be renewed.
 *
 * A slot leaks when its process dies mid-request, and when a release lands on
 * the memory fallback because the coordinator faulted between acquire and
 * release; either way the key is locked out for this long. Five minutes: long
 * enough that renewal is cheap, short enough that a fault is not an hour of
 * refusals on a `concurrency: 1` key.
 *
 * Expiry applies in every gauge implementation, so this TTL bounds a *live*
 * holder as much as a dead one — and `requestDeadlineMs` is 0 (unlimited) by
 * default, so nothing else keeps a request under it. That is why the slot is
 * named and renewed on `RENEW_INTERVAL_MS`: without renewal a request running
 * past five minutes stops being counted and the next one is admitted beside
 * it, breaking a ceiling `docs/operations.md` promises "goes on enforcing
 * exactly".
 */
const GAUGE_TTL_MS = 300_000;

/**
 * How often a live request pushes its slot's expiry out.
 *
 * A third of the TTL, so two consecutive failures still leave a full interval
 * before the slot lapses. Renewal is one command against a key already in
 * cache, and only for keys that set `concurrency`, so the cost is a rounding
 * error against the request it protects.
 */
const RENEW_INTERVAL_MS = 100_000;

/**
 * How long renewal may go on before a slot is left to lapse.
 *
 * Renewal is what keeps the ceiling honest for a long request, but an
 * unrenewed slot's TTL is also the only thing that reclaims one whose release
 * never ran — a streaming `Response` nobody reads is the reachable case
 * (`routes/proxy.ts` documents it). Renewing forever would make that leak
 * permanent instead of five minutes long, trading a ceiling that breaks late
 * for a ceiling that never recovers.
 *
 * A day: far past any real inference request, so the cap is invisible to
 * legitimate traffic, and short enough that a leaked slot does not outlive the
 * gateway. Past it the old behaviour returns exactly — the slot lapses and one
 * extra request is admitted beside it.
 */
const MAX_RENEWED_MS = 86_400_000;

/** Where a subject's long-window buckets live: `lim:<subject>:<window>`. */
function bucketKey(subject: string, window: LongWindow): string {
  return `lim:${subject}:${window}`;
}

/**
 * What one model override's ring, gauge and buckets are keyed by.
 *
 * `encodeURIComponent` takes `/` and `:` out of the model part, so no model
 * name can spell another subject's key — a model named `a/m/b` is
 * `k1/m/a%2Fm%2Fb`, never a second `/m/` — and `lim:<subject>:<window>` keeps
 * exactly one reading.
 */
export function modelSubjectId(keyId: string, model: string): string {
  return `${keyId}/m/${encodeURIComponent(model)}`;
}

/**
 * One set of counters a request is judged against: the key-wide limits, keyed
 * by the key's id, or one model override's, keyed by `modelSubjectId`.
 *
 * `keyId` and `model` are what the store is asked about when the subject's
 * long windows are seeded or a refusal's reset is read; `id` is what the
 * coordinator is asked about.
 */
type Subject = {
  id: string;
  keyId: string;
  /** Undefined for the key-wide subject, whose store reads span every model. */
  model: string | undefined;
  limits: LimitConfigBase;
};

/** The key-wide matrix, without the overrides `evaluate` must never be handed. */
function keyWide(limits: LimitConfig): LimitConfigBase {
  const { models: _models, ...base } = limits;
  return base;
}

/**
 * Every subject a request for `model` is judged against, key-wide first.
 *
 * A key-wide scope that limits nothing is left out, so it claims nothing: a
 * key whose only limit is one model's override allocates nothing for any other
 * model. Key-wide first is also the order `combine` breaks ties in.
 */
function subjectsOf(keyId: string, limits: LimitConfig, model: string): Subject[] {
  const subjects: Subject[] = [];
  const base = keyWide(limits);
  if (anyLimit(base)) subjects.push({ id: keyId, keyId, model: undefined, limits: base });
  const override = modelOverride(limits, model);
  // No `anyLimit` here: the schema refuses an override that limits nothing.
  if (override !== undefined) {
    subjects.push({ id: modelSubjectId(keyId, model), keyId, model, limits: override });
  }
  return subjects;
}

/**
 * What an admitted request carries away from the check.
 *
 * The release is the concurrency slot; the headroom is what the response's
 * rate-limit headers are rendered from. Both come from the one evaluation, so a
 * route never asks the limiter a second question about a decision it already
 * made.
 *
 * `renew` pushes the slot's expiry out and is what the limiter's own timer
 * calls. It is on the admission rather than the limiter because the slot's name
 * is private: the holder is the only thing entitled to renew it, and handing
 * out the name would let one request renew another's.
 */
export type Admission = {
  release: () => void;
  headroom: HeadroomByDimension;
  /** Idempotent no-op for a key with no `concurrency` ceiling. */
  renew: () => Promise<void>;
};

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
  /** The subject the claim was taken against, and therefore where it is given back. */
  subject: string;
  /** The ring stamp that was recorded, and therefore the one to give back. */
  stamp: number;
  /** Whether the gauge was raised. `consume` claims a ring slot and nothing else. */
  gauge: boolean;
  /**
   * The slot's name, when the key has a `concurrency` ceiling. A rollback
   * addresses this slot rather than whichever is nearest its expiry, so a
   * refusal cannot hand back a live request's slot.
   */
  holder: string | undefined;
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
function anyRequestLimit(limits: LimitConfigBase): boolean {
  for (const window of ["1m", "5h", "1w"] as const) {
    if (configured(limits.requests?.[window])) return true;
  }
  return false;
}

/** Whether anything at all is limited, so an unlimited key can allocate nothing. */
function anyLimit(limits: LimitConfigBase): boolean {
  if (configured(limits.concurrency) || anyRequestLimit(limits)) return true;
  for (const window of ["1m", "5h", "1w"] as const) {
    if (configured(limits.tokens?.[window])) return true;
  }
  return configured(limits.spend?.["5h"]) || configured(limits.spend?.["1w"]);
}

/** Whether any long window is configured, so a store read is worth issuing. */
function anyLongLimit(limits: LimitConfigBase): boolean {
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
   * The limits last seen at admission, per subject, so a debit knows whether a
   * long window is configured at all — key-wide and for the request's model
   * apart. ponytail: never pruned; bounded by the keys and overrides an
   * operator has configured, which is dozens.
   */
  private readonly limits = new Map<string, LimitConfigBase>();
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
   * a gauge is expired by nothing the caller can see, so a leak locks the key
   * out permanently and says nothing while it does.
   *
   * The slot is named — with a uuid this method owns, never `requestId` — and
   * renewed while the request runs, because `GAUGE_TTL_MS` expires a live
   * holder as readily as a dead one and no request deadline bounds it by
   * default. The release stops the renewal; renewal itself stops at
   * `MAX_RENEWED_MS`.
   *
   * `model` is the requested model, after `[1m]` normalization. Where the key
   * overrides it, this one admission claims both subjects, judges both, and on
   * any refusal or failure gives back both: two admissions would leave a
   * request refused by its model ceiling holding a key-wide stamp and slot.
   * Such an admission may hold two slots; its release frees both and its
   * renew renews both.
   */
  async admit(
    keyId: string,
    limits: LimitConfig,
    model: string,
    requestId?: string,
  ): Promise<Admission> {
    const subjects = subjectsOf(keyId, limits, model);
    // An unlimited key allocates nothing, so an install that sets no limits
    // pays no memory for the mechanism — and renders no headers, because there
    // is no ceiling to report a distance from.
    if (subjects.length === 0) return { release: () => {}, renew: async () => {}, headroom: {} };

    const now = this.now();
    const claims: Claim[] = [];
    let admitted = false;
    try {
      for (const subject of subjects) {
        this.limits.set(subject.id, subject.limits);
        // The limiter owns this name; it is deliberately NOT `requestId`.
        //
        // A named slot is idempotent by design — re-acquiring one name moves
        // its expiry instead of adding a slot — so the name has to be unique
        // per *admission*, and a caller-supplied id cannot be trusted to be.
        // Two concurrent requests sharing one id would hold a single slot
        // between them, and the ceiling would admit past itself: a limit that
        // under-counts is worse than no limit, because the operator believes
        // they set one. `requestId` stays what it was, a log correlation key.
        const holder = configured(subject.limits.concurrency) ? crypto.randomUUID() : undefined;
        // In sequence, each before anything is judged. `Coord` makes every
        // claim visible the instant it is made, so a burst cannot admit past
        // either subject's ceiling. The cost is that a claim is provisional and
        // visible: this request's key-wide claim counts against a concurrent
        // request for another model until a model refusal rolls it back —
        // over-counting for one evaluation, the direction the limiter permits.
        claims.push(await this.claim(subject.id, now, true, holder));
      }
      const decision = await this.judge(subjects, claims, (scope) => scope, now, requestId);
      admitted = true;

      // Only the slots judged against a ceiling are renewed: a subject without
      // `concurrency` raised an anonymous slot nothing counts.
      const held = claims.flatMap((claim) =>
        claim.holder === undefined ? [] : [{ subject: claim.subject, holder: claim.holder }],
      );
      let released = false;
      // Renewal is bounded, because an unbounded one turns a leak that used to
      // heal into one that never does.
      //
      // The slot's TTL was what reclaimed a slot whose release never ran — a
      // streaming `Response` nobody reads, a consumer that drops the events.
      // A timer that renews forever keeps that slot, and its key's ceiling,
      // occupied for the life of the process. So renewal stops at
      // `MAX_RENEWED_MS`: past that the slot lapses on its own and the leak
      // heals exactly as it did before renewal existed. A request legitimately
      // running longer than the cap loses its slot and admits one extra
      // alongside — the old failure, now reachable only after a day rather
      // than after five minutes.
      const renewUntil = now + MAX_RENEWED_MS;
      const renew = async () => {
        if (released) return;
        for (const slot of held)
          await this.coord.gauge.renew(slot.subject, slot.holder, GAUGE_TTL_MS);
      };
      // Nothing to renew for a key without a concurrency ceiling: its gauge
      // slot is not judged against anything. One timer for every held slot.
      const renewal =
        held.length === 0
          ? null
          : setInterval(() => {
              if (this.now() >= renewUntil) {
                clearInterval(renewal ?? undefined);
                return;
              }
              void renew();
            }, RENEW_INTERVAL_MS);
      // A renewal timer must never be what keeps the process alive: the
      // request it tracks is the thing being waited on.
      renewal?.unref?.();

      const release = () => {
        if (released) return;
        released = true;
        if (renewal !== null) clearInterval(renewal);
        for (const claim of claims) void this.coord.gauge.release(claim.subject, claim.holder);
      };
      return { release, renew, headroom: decision.headroom };
    } finally {
      // Where the claim stops being provisional. An admitted request keeps it
      // until its release; anything else — a refusal, a failure while judging,
      // or a failure claiming a later subject — gives back every part of every
      // subject's claim, because a leak here locks the key out for
      // `MAX_RENEWED_MS` and says nothing while it does.
      if (!admitted) for (const claim of claims) await this.rollback(claim);
    }
  }

  /**
   * Judges a `count_tokens` request, which consumes `requests` and nothing else.
   *
   * It performs no dispatch, so it consumes no upstream tokens and costs
   * nothing; charging it against a token budget would bill an operator for an
   * estimate this process computed itself. It holds nothing open either, so it
   * neither raises the concurrency gauge nor is judged against it. A model
   * override's `requests` applies here as the key-wide one does, and its
   * other dimensions do not.
   */
  async consume(
    keyId: string,
    limits: LimitConfig,
    model: string,
    requestId?: string,
  ): Promise<void> {
    const subjects = subjectsOf(keyId, limits, model).filter((subject) =>
      anyRequestLimit(subject.limits),
    );
    if (subjects.length === 0) return;

    const now = this.now();
    const claims: Claim[] = [];
    let consumed = false;
    try {
      for (const subject of subjects) {
        this.limits.set(subject.id, subject.limits);
        claims.push(await this.claim(subject.id, now, false));
      }
      await this.judge(subjects, claims, requestsOnly, now, requestId);
      consumed = true;
    } finally {
      if (!consumed) for (const claim of claims) await this.rollback(claim);
    }
  }

  /**
   * Judges every subject against its own counters, and refuses if any refuses.
   *
   * Each subject is evaluated alone and the decisions are combined, so the
   * `Retry-After` names the scope that clears last and each header the scope
   * nearest exhaustion. `scope` narrows what is judged — `consume` passes only
   * `requests`.
   */
  private async judge(
    subjects: readonly Subject[],
    claims: readonly Claim[],
    scope: (limits: LimitConfigBase) => LimitConfigBase,
    now: number,
    requestId: string | undefined,
  ): Promise<Decision> {
    const decisions: Decision[] = [];
    for (const [index, subject] of subjects.entries()) {
      const claim = claims[index];
      // One claim per subject, pushed in the same order: unreachable.
      if (claim === undefined) throw new Error("rate limit claim missing for a subject");
      const limits = scope(subject.limits);
      const counters = await this.counters(subject, limits, claim, now, requestId);
      decisions.push(evaluate(limits, counters, now));
    }
    const decision = combineAll(decisions);
    if (decision.violation !== null) await this.refuse(subjects, decisions, now, requestId);
    return decision;
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
  private async claim(
    subject: string,
    now: number,
    gauge: boolean,
    holder?: string,
  ): Promise<Claim> {
    const ring = await this.coord.window.claim(subject, WINDOW_MS["1m"], now);
    let concurrency: number;
    try {
      concurrency = gauge
        ? await this.coord.gauge.acquire(subject, GAUGE_TTL_MS, holder)
        : await this.coord.gauge.read(subject);
    } catch (error) {
      // The ring stamp is already recorded and the caller has no claim to give
      // back yet, so this is the only place that can return it.
      await this.coord.window.rollback(subject, ring.stamp);
      throw error;
    }
    return {
      subject,
      stamp: ring.stamp,
      gauge,
      holder,
      before: { requests: ring.before, concurrency },
    };
  }

  /** Gives back every part of a claim, for a request that will not be served. */
  private async rollback(claim: Claim): Promise<void> {
    await this.coord.window.rollback(claim.subject, claim.stamp);
    if (claim.gauge) await this.coord.gauge.release(claim.subject, claim.holder);
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
  debit(keyId: string, requestedModel: string, usage: { tokens: number; costUsd: number }): void {
    const delta = { requests: 1, tokens: usage.tokens, costUsd: usage.costUsd };
    this.debitSubject(keyId, delta);
    // The model's subject only where this process admitted it under an
    // override; for any other model there is no entry and nothing is added.
    this.debitSubject(modelSubjectId(keyId, requestedModel), delta);
  }

  private debitSubject(subject: string, delta: Counts): void {
    const limits = this.limits.get(subject);
    // A subject this process never admitted has nothing to add to: its row is
    // written, and whoever seeds the subject next counts it. Asked before the
    // clock is, so a key with no long window reads it no extra time.
    if (limits === undefined || !anyLongLimit(limits)) return;
    const now = this.now();
    for (const window of LONG_WINDOWS) {
      void this.coord.buckets.add(
        bucketKey(subject, window),
        GRAIN_MS[window],
        WINDOW_MS[window],
        now,
        delta,
      );
    }
  }

  /**
   * In-flight requests for one subject: a key's id, or `modelSubjectId` for
   * one model's override. Zero for a subject holding nothing.
   */
  inFlight(subject: string): Promise<number> {
    return this.coord.gauge.read(subject);
  }

  /**
   * Refuses a request one of its subjects refused, with a wait that is true.
   *
   * Every violated long window has its reset corrected first — in every subject,
   * not only the one an overstated figure made look last — and only then is the
   * one clearing last chosen. Chosen the other way round, a `5h` window reported
   * at its far end beat a `1m` refusal that had 59 seconds to run, was then
   * corrected to the five seconds its oldest row actually had left, and the
   * client was sent back into the minute ceiling 54 seconds early.
   */
  private async refuse(
    subjects: readonly Subject[],
    decisions: readonly Decision[],
    now: number,
    requestId: string | undefined,
  ): Promise<never> {
    const corrected: Decision[] = [];
    for (const [index, scope] of decisions.entries()) {
      const subject = subjects[index];
      if (subject === undefined) throw new Error("rate limit decision from no subject");
      corrected.push(await this.correct(subject, scope, now, requestId));
    }
    const decision = combineAll(corrected);
    const violation = decision.violation;
    // Unreachable: the caller refuses only a decision with a violation, and
    // correcting a reset never removes one.
    if (violation === null) throw new Error("rate limit refusal with no violation");

    // A denied request keeps nothing: its caller rolls back the ring stamp and
    // the gauge slot the check claimed before it ran, so a key hammering its own
    // ceiling does not push itself further past it.
    try {
      this.onRejected?.(violation.dimension, violation.window);
    } catch {
      // Observability cannot turn a refusal into a different failure.
    }
    throw new RateLimitExceeded(retryAfterMs(violation, now), decision.headroom);
  }

  /**
   * One subject's decision with each violated long window's true reset.
   *
   * The reads this design makes on the refusal path and nowhere else: one per
   * violated window of the subject, asked of that subject's own rows. Its
   * headers move with it, so a 429 names the same instant as its `Retry-After`.
   */
  private async correct(
    subject: Subject,
    scope: Decision,
    now: number,
    requestId: string | undefined,
  ): Promise<Decision> {
    if (scope.violations.length === 0) return scope;
    const exact = new Map<Window, number>();
    for (const violation of scope.violations) {
      const window = violation.window;
      if (window === null || exact.has(window)) continue;
      const reset = await this.exactReset(subject, window, now, requestId);
      if (reset !== null) exact.set(window, reset);
    }
    const violations = scope.violations.map((violation) => {
      const reset = violation.window === null ? undefined : exact.get(violation.window);
      return reset === undefined ? violation : { ...violation, resetAt: reset };
    });
    let headroom = scope.headroom;
    for (const [window, reset] of exact) headroom = withReset(headroom, window, reset);
    return { ...scope, violation: lastToClear(violations), violations, headroom };
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
    subject: Subject,
    window: Window | null,
    now: number,
    requestId: string | undefined,
  ): Promise<number | null> {
    if (window === null || window === "1m") return null;
    const length = WINDOW_MS[window];
    try {
      const oldest = await this.store.usage.oldestSince(subject.keyId, now - length, subject.model);
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
        apiKeyId: subject.keyId,
        ...(subject.model === undefined ? {} : { model: subject.model }),
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
    subject: Subject,
    limits: LimitConfigBase,
    claim: Claim,
    now: number,
    requestId: string | undefined,
  ): Promise<CounterSnapshot> {
    const requests: DimensionCounters = { "1m": claim.before.requests };
    const snapshot: CounterSnapshot = { requests, concurrency: claim.before.concurrency };
    if (!anyLongLimit(limits)) return snapshot;

    const counts = await this.longCounts(subject, now, requestId);
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
   * There is deliberately no timeout on the seed read, and the reason is the
   * SQLite backend alone: `bun:sqlite` is synchronous, so the timer that would
   * fire cannot run until the query it is bounding has returned, and a deadline
   * there is a promise the runtime cannot keep. On the Postgres backend the
   * loop is free and a deadline would hold — the coordinator's own commands
   * carry one for exactly that reason (`COMMAND_TIMEOUT_MS` in
   * `coord/redis.ts`). Do not read this paragraph as saying a slow store cannot
   * stall a request; on a cluster it can, and bounding it is open work.
   */
  private async longCounts(
    subject: Subject,
    now: number,
    requestId: string | undefined,
  ): Promise<Record<LongWindow, Counts> | null> {
    const out = {} as Record<LongWindow, Counts>;
    for (const window of LONG_WINDOWS) {
      const key = bucketKey(subject.id, window);
      const grain = GRAIN_MS[window];
      const length = WINDOW_MS[window];
      let sum = await this.coord.buckets.sum(key, grain, length, now);
      if (sum === null) {
        try {
          sum = await this.seed(subject, window, now);
        } catch (error) {
          this.logger.warn("rate limit counters unavailable", {
            ...(requestId === undefined ? {} : { requestId }),
            apiKeyId: subject.keyId,
            ...(subject.model === undefined ? {} : { model: subject.model }),
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
  private async seed(subject: Subject, window: LongWindow, now: number): Promise<Counts> {
    const key = bucketKey(subject.id, window);
    const grain = GRAIN_MS[window];
    const length = WINDOW_MS[window];
    const install = async (): Promise<Counts> => {
      const already = await this.coord.buckets.sum(key, grain, length, now);
      if (already !== null) return already;
      // A model's subject seeds from that model's rows alone.
      const rows = await this.store.usage.sumBuckets(
        subject.keyId,
        now - length,
        grain,
        subject.model,
      );
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

/** What `count_tokens` is judged against: `requests`, and nothing else. */
function requestsOnly(limits: LimitConfigBase): LimitConfigBase {
  return limits.requests === undefined ? {} : { requests: limits.requests };
}

/**
 * Rewrites the reset of every reported dimension sitting on one window.
 *
 * So the headers on a 429 name the same instant as the `Retry-After` beside
 * them. A response that says "wait an hour" in one field and "wait a week" in
 * the next is worse than either figure alone: the client obeys whichever its
 * SDK happens to read.
 *
 * Applied to one subject's headroom before the subjects are combined, because
 * the instant was read from that subject's rows: the other scope's window of
 * the same name frees when *its* oldest row ages out.
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

/** The subjects' decisions as one, key-wide first, which is `combine`'s tie order. */
function combineAll(decisions: readonly Decision[]): Decision {
  const [first, ...rest] = decisions;
  if (first === undefined) return { allowed: true, violation: null, violations: [], headroom: {} };
  return rest.reduce(combine, first);
}
