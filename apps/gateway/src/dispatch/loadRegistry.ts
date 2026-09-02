import { type Coord, memoryCoord } from "@omni/coord";
import { healthKey } from "@omni/router";

/**
 * How many requests are in flight against each (credential, model) right now.
 *
 * The router ranks on this so a burst of simultaneous requests fans out instead
 * of stacking. Nothing else can answer the question: `lastUsedAt` only moves
 * when a request *finishes*, so twenty requests that arrive together all read
 * the same history and all pick the same credential.
 *
 * Two sources, read together. A local map is exact and synchronous — a burst
 * on one process claims and ranks without yielding between the two, which is
 * what lets each request see the one before it. A gauge behind `Coord` carries
 * the fleet's picture, sampled once per request by `refresh` and one round
 * trip stale by construction; a burst split across processes can stack for
 * that long, and nothing short of ranking inside the shared service could
 * prevent it. `counts` reports the larger of the two per key, so one process
 * never under-reads itself and never double-counts what it published.
 */
export type LoadRegistry = {
  /**
   * Claims a slot and returns the release for it.
   *
   * Synchronous, and the local count moves before this returns. The release
   * is idempotent: calling it twice frees one slot, not two. That matters
   * because a leaked or double-counted slot has no visible symptom — it
   * silently deranks a credential until the process restarts.
   */
  acquire(credentialId: string, model: string): () => void;
  /** In-flight count per `healthKey`. A missing key means zero. */
  counts(): ReadonlyMap<string, number>;
  /** Samples the fleet's gauge. Call before `counts`, on a path that may yield. */
  refresh(): Promise<void>;
};

/** Namespaces the gauge, so a snapshot lists load and nothing else. */
const PREFIX = "load:";

/**
 * How long a shared gauge holds a slot for a process that never released it.
 * Ignored in memory; see the same constant in `auth/rateLimit.ts` for why it
 * is a floor on a leaked slot's life rather than a bound on a request's.
 */
const SLOT_TTL_MS = 3_600_000;

export function createLoadRegistry(coord: Coord = memoryCoord()): LoadRegistry {
  const local = new Map<string, number>();
  let remote: ReadonlyMap<string, number> = new Map();

  return {
    acquire(credentialId, model) {
      const key = healthKey(credentialId, model);
      local.set(key, (local.get(key) ?? 0) + 1);
      void coord.gauge.acquire(PREFIX + key, SLOT_TTL_MS);

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = (local.get(key) ?? 0) - 1;
        if (next > 0) local.set(key, next);
        else local.delete(key);
        void coord.gauge.release(PREFIX + key);
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

    async refresh() {
      const held = await coord.gauge.snapshot(PREFIX);
      const sample = new Map<string, number>();
      for (const [key, count] of held) sample.set(key.slice(PREFIX.length), count);
      remote = sample;
    },
  };
}
