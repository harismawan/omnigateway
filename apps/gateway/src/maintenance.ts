import { type Logger, noopLogger } from "@omni/ir";
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
 *
 * Retained quota samples go on the raw horizon rather than the rollup's: a
 * sample describes one moment of one window, and nothing rolls it up into a
 * cheaper form worth keeping for a year.
 */
export async function pruneLogs(
  store: Store,
  now: number,
): Promise<{ raw: number; daily: number; quotaSamples: number }> {
  const settings = await store.config.getSettings();
  const rawHorizon = now - settings.logRetentionDays * DAY_MS;
  const raw = await store.usage.prune(rawHorizon);
  const daily = await store.usage.pruneDaily(now - ROLLUP_RETENTION_DAYS * DAY_MS);
  const quotaSamples = await store.credentials.pruneQuotaSamples(rawHorizon);
  return { raw, daily, quotaSamples };
}

export type MaintenanceDeps = { store: Store; now: () => number; logger?: Logger };

/** Starts the hourly sweep. Returns a function that stops it. */
export function startMaintenance(deps: MaintenanceDeps): () => void {
  const logger = deps.logger ?? noopLogger;
  const timer = setInterval(() => {
    void pruneLogs(deps.store, deps.now())
      .then(({ raw, daily, quotaSamples }) =>
        logger.debug("request logs pruned", {
          rawCount: raw,
          dailyCount: daily,
          quotaSampleCount: quotaSamples,
        }),
      )
      .catch((error: unknown) => {
        logger.error("log pruning failed", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      });
  }, SWEEP_INTERVAL_MS);

  // Do not hold the process open for a maintenance timer.
  timer.unref?.();

  return () => clearInterval(timer);
}
