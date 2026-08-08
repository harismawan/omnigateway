import type { Store } from "@omni/store";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long the daily rollup outlives the raw logs. A year of history plus a
 * margin, so the console's activity grid is never short of its own window
 * while the table still has a bound.
 */
export const ROLLUP_RETENTION_DAYS = 400;

/**
 * Deletes request logs past the configured retention window, and rollup rows
 * past the far longer one. The rollup is what survives to answer "last year",
 * so it is deliberately not governed by `logRetentionDays`.
 */
export async function pruneLogs(store: Store, now: number): Promise<void> {
  const settings = await store.config.getSettings();
  await store.usage.prune(now - settings.logRetentionDays * DAY_MS);
  await store.usage.pruneDaily(now - ROLLUP_RETENTION_DAYS * DAY_MS);
}

export type MaintenanceDeps = { store: Store; now: () => number };

/** Starts the hourly sweep. Returns a function that stops it. */
export function startMaintenance(deps: MaintenanceDeps): () => void {
  const timer = setInterval(() => {
    void pruneLogs(deps.store, deps.now()).catch((error: unknown) => {
      console.error("log pruning failed", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    });
  }, SWEEP_INTERVAL_MS);

  // Do not hold the process open for a maintenance timer.
  timer.unref?.();

  return () => clearInterval(timer);
}
