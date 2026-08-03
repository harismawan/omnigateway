import type { Store } from "@omni/store";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Deletes request logs past the configured retention window. */
export async function pruneLogs(store: Store, now: number): Promise<void> {
  const settings = await store.config.getSettings();
  const cutoff = now - settings.logRetentionDays * 24 * 60 * 60 * 1000;
  await store.usage.prune(cutoff);
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
