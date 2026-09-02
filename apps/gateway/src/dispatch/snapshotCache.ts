import { type Logger, noopLogger } from "@omni/ir";
import { buildSnapshot, healthKey, type Snapshot } from "@omni/router";
import type { RoutingChange, Store } from "@omni/store";

export type RoutingSnapshotSource = {
  get(now: number): Promise<Snapshot>;
};

export type RoutingSnapshotCache = RoutingSnapshotSource & {
  /**
   * A change another process made, handed in as if the local store had
   * emitted it: health and quota rows patch the held snapshot in place, and a
   * configuration change marks it stale. What the local subscription does for
   * local writes, for writes the fan-out carried.
   */
  applyRemote(change: RoutingChange): void;
  /**
   * Drops what is held, for a change the version check cannot see.
   *
   * Staleness is otherwise decided by SQLite's `data_version`, which belongs to
   * the open connection — so a restore, which closes the handle and opens a new
   * one over a different file, is the one change that can leave the counter
   * agreeing with itself across a completely different database.
   */
  invalidate(): void;
  close(): void;
};

export function createRoutingSnapshotCache(
  store: Store,
  logger: Logger = noopLogger,
): RoutingSnapshotCache {
  let snapshot: Snapshot | null = null;
  let stale = true;
  let version = store.routing.version();
  let generation = 0;
  let inFlight: Promise<Snapshot> | null = null;

  const apply = (change: RoutingChange): void => {
    generation++;
    if (snapshot === null || stale) return;

    if (change.type === "healthSaved") {
      const health = new Map(snapshot.health);
      for (const row of change.rows) health.set(healthKey(row.credentialId, row.model), row);
      snapshot = { ...snapshot, health };
      return;
    }

    if (change.type === "quotaSaved") {
      const quota = new Map(snapshot.quota);
      const credentialIds = new Set(change.rows.map((row) => row.credentialId));
      for (const credentialId of credentialIds) {
        quota.set(
          credentialId,
          change.rows.filter((row) => row.credentialId === credentialId),
        );
      }
      snapshot = { ...snapshot, quota };
      return;
    }

    stale = true;
  };

  const unsubscribe = store.routing.subscribe(apply);

  const get = async (now: number): Promise<Snapshot> => {
    const currentVersion = store.routing.version();
    if (currentVersion !== version) stale = true;
    if (snapshot !== null && !stale) return snapshot;
    if (inFlight !== null) return inFlight;

    const buildGeneration = generation;
    const buildVersion = currentVersion;
    logger.debug("routing snapshot cache miss");
    inFlight = buildSnapshot(store, now)
      .then(async (next) => {
        const completedVersion = store.routing.version();
        if (generation !== buildGeneration || completedVersion !== buildVersion) {
          inFlight = null;
          return get(now);
        }
        snapshot = next;
        version = completedVersion;
        stale = false;
        return next;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    get,
    applyRemote: apply,
    invalidate() {
      // The generation bump is what discards a build already in flight: it
      // began against the file that has just been replaced.
      generation++;
      snapshot = null;
      stale = true;
      version = store.routing.version();
    },
    close: unsubscribe,
  };
}
