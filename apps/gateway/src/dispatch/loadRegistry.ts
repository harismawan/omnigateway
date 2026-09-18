import { type Coord, memoryCoord } from "@omni/coord";
import type { ProviderId } from "@omni/ir";
import { healthKey, type RecentUse } from "@omni/router";

/**
 * How many requests are in flight against each (credential, model) right now.
 *
 * The router ranks on this so a burst of simultaneous requests fans out instead
 * of stacking. Nothing else can answer the question: the release stamp below
 * only moves when a request *finishes*, so twenty requests that arrive together
 * all read the same history and all pick the same credential.
 *
 * Two sources, read together. A local map is exact and synchronous — a burst
 * on one process claims and ranks without yielding between the two, which is
 * what lets each request see the one before it. A gauge behind `Coord` carries
 * the fleet's picture, sampled once per request by `refresh` and one round
 * trip stale by construction; a burst split across processes can stack for
 * that long, and nothing short of ranking inside the shared service could
 * prevent it. `counts` reports the larger of the two per key, so one process
 * never under-reads itself and never double-counts what it published.
 *
 * The release hook is also where this process learns a request finished, so
 * it keeps the two measurements routing reads — when each pair was last
 * released, and this process's latency average — in the same local map. They
 * used to ride `credential_health`, which cost every successful request a
 * store write; here they cost nothing and describe *this* node's path to the
 * provider, which is the one that matters to its own ranking.
 */
export type LoadRegistry = {
  /**
   * Claims a slot and returns the release for it.
   *
   * Synchronous, and the local count moves before this returns. The release
   * is idempotent: calling it twice frees one slot, not two. That matters
   * because a leaked or double-counted slot has no visible symptom — it
   * silently deranks a credential until the process restarts.
   *
   * The release takes the attempt's time-to-first-token when it has one; the
   * first call stamps `lastReleasedAt` and folds the sample into the average.
   */
  acquire(
    credentialId: string,
    model: string,
    provider?: ProviderId,
  ): (ttftMs?: number | null) => void;
  /** In-flight count per `healthKey`. A missing key means zero. */
  counts(): ReadonlyMap<string, number>;
  /** This process's record per `healthKey`. A missing key means never released here. */
  recent(): ReadonlyMap<string, RecentUse>;
  /** Synchronous process-local provider totals, for per-instance observability only. */
  localCounts?(): ReadonlyMap<ProviderId, number>;
  /** Samples the fleet's gauge. Call before `counts`, on a path that may yield. */
  refresh(): Promise<void>;
};

/** Namespaces the gauge, so a snapshot lists load and nothing else. */
const PREFIX = "load:";

/**
 * How long a shared gauge holds a slot before it must be renewed.
 *
 * Expiry applies in the memory gauge too — `liveSlots` filters on it — so this
 * bounds a *live* request's slot, not only a leaked one, and
 * `requestDeadlineMs` (0 by default) no longer keeps requests under it. The
 * slot is therefore named and renewed while the request runs; without that, a
 * request past five minutes stops counting toward load and ranking stacks
 * further traffic onto the same credential and model.
 */
const SLOT_TTL_MS = 300_000;

/** A third of the TTL, so two consecutive failures still leave a full interval. */
const RENEW_INTERVAL_MS = 100_000;

/**
 * How long renewal may go on before a slot is left to lapse.
 *
 * Same bound and same reason as `MAX_RENEWED_MS` in `auth/rateLimit.ts`: the
 * TTL is what reclaims a slot whose release never ran, so renewing forever
 * would make a dropped `DispatchOutcome` undercount this node's load for the
 * life of the process rather than for five minutes.
 */
const MAX_RENEWED_MS = 86_400_000;

/** Weight of the newest latency sample. Low enough to ride out one slow call. */
const EWMA_ALPHA = 0.3;

export function createLoadRegistry(
  coord: Coord = memoryCoord(),
  now: () => number = Date.now,
): LoadRegistry {
  const local = new Map<string, number>();
  const providers = new Map<ProviderId, number>();
  const history = new Map<string, RecentUse>();
  let remote: ReadonlyMap<string, number> = new Map();

  return {
    acquire(credentialId, model, provider) {
      const key = healthKey(credentialId, model);
      local.set(key, (local.get(key) ?? 0) + 1);
      if (provider !== undefined) providers.set(provider, (providers.get(provider) ?? 0) + 1);
      // Named and renewed for the same reason as the concurrency slot: the TTL
      // expires a live holder, and no request deadline bounds one by default.
      // The local map is exact regardless; this keeps the *shared* count honest
      // for other replicas. A uuid rather than a node id and counter, because
      // the name needs only to be unique, and this registry is handed no
      // identity of its own.
      const holder = crypto.randomUUID();
      void coord.gauge.acquire(PREFIX + key, SLOT_TTL_MS, holder);
      const renewUntil = now() + MAX_RENEWED_MS;
      const renewal = setInterval(() => {
        // Bounded for the same reason as the concurrency slot: a consumer that
        // drops its events never releases, and the TTL is what reclaims that.
        if (now() >= renewUntil) {
          clearInterval(renewal);
          return;
        }
        void coord.gauge.renew(PREFIX + key, holder, SLOT_TTL_MS);
      }, RENEW_INTERVAL_MS);
      renewal.unref?.();

      let released = false;
      return (ttftMs) => {
        if (released) return;
        released = true;
        clearInterval(renewal);
        const prior = history.get(key)?.ewmaTtftMs ?? null;
        history.set(key, {
          lastReleasedAt: now(),
          ewmaTtftMs:
            ttftMs === undefined || ttftMs === null
              ? prior
              : prior === null
                ? ttftMs
                : prior * (1 - EWMA_ALPHA) + ttftMs * EWMA_ALPHA,
        });
        const next = (local.get(key) ?? 0) - 1;
        if (next > 0) local.set(key, next);
        else local.delete(key);
        if (provider !== undefined) {
          const providerCount = (providers.get(provider) ?? 0) - 1;
          if (providerCount > 0) providers.set(provider, providerCount);
          else providers.delete(provider);
        }
        void coord.gauge.release(PREFIX + key, holder);
      };
    },

    counts() {
      // A copy, because ranking holds this for the life of a request and must
      // see one consistent picture rather than a map shifting underneath it.
      const out = new Map(local);
      for (const [key, count] of remote) {
        if (count > (out.get(key) ?? 0)) out.set(key, count);
      }
      return out;
    },

    localCounts() {
      return new Map(providers);
    },

    recent() {
      return history;
    },

    async refresh() {
      const held = await coord.gauge.snapshot(PREFIX);
      const sample = new Map<string, number>();
      for (const [key, count] of held) sample.set(key.slice(PREFIX.length), count);
      remote = sample;
    },
  };
}
