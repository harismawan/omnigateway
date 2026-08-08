import { buildSnapshot, healthKey, type Snapshot } from "@omni/router";
import type { RoutingChange, Store } from "@omni/store";

export type RoutingSnapshotSource = {
  get(now: number): Promise<Snapshot>;
};

export type RoutingSnapshotCache = RoutingSnapshotSource & {
  close(): void;
};

export function createRoutingSnapshotCache(store: Store): RoutingSnapshotCache {
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

  return { get, close: unsubscribe };
}
