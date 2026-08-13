import { type Logger, noopLogger } from "@omni/ir";
import { healthKey } from "@omni/router";

/**
 * How many requests are in flight against each (credential, model) right now.
 *
 * The router ranks on this so a burst of simultaneous requests fans out instead
 * of stacking. Nothing else can answer the question: `lastUsedAt` only moves
 * when a request *finishes*, so twenty requests that arrive together all read
 * the same history and all pick the same credential.
 *
 * Process-local, like the rate limits and quota cooldowns, and correct only
 * because the gateway runs as a single process.
 */
export type LoadRegistry = {
  /**
   * Claims a slot and returns the release for it.
   *
   * The release is idempotent: calling it twice frees one slot, not two. That
   * matters because a leaked or double-counted slot has no visible symptom —
   * it silently deranks a credential until the process restarts.
   */
  acquire(credentialId: string, model: string): () => void;
  /** In-flight count per `healthKey`. A missing key means zero. */
  counts(): ReadonlyMap<string, number>;
};

export function createLoadRegistry(logger: Logger = noopLogger): LoadRegistry {
  const counts = new Map<string, number>();

  return {
    acquire(credentialId, model) {
      const key = healthKey(credentialId, model);
      counts.set(key, (counts.get(key) ?? 0) + 1);

      let released = false;
      return () => {
        if (released) return;
        released = true;

        const next = (counts.get(key) ?? 0) - 1;
        if (next > 0) {
          counts.set(key, next);
          return;
        }
        if (next < 0) {
          // Unreachable through `acquire`, so this is a bug rather than a race.
          logger.warn("load registry released more than it acquired", { credentialId });
        }
        counts.delete(key);
      };
    },

    counts() {
      // A copy, because ranking holds this for the life of a request and must
      // see one consistent picture rather than a map shifting underneath it.
      return new Map(counts);
    },
  };
}
