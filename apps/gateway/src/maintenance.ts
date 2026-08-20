import { type DatabaseDeps, nodeDatabaseFs, pruneSnapshots, sweepStaging } from "@omni/control";
import { describeError, type Logger, noopLogger } from "@omni/ir";
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
 *
 * Captured bodies go on the raw horizon too, and for a reason beyond symmetry:
 * an artifact whose request log has already expired is a prompt corpus nothing
 * can be joined to. Two further sweeps run with it, because either alone fails.
 * The window is what an operator reasons about and it bounds nothing — a week
 * of sustained traffic is unbounded in practice — so `pruneToCap` is the
 * backstop that actually bounds disk. `sweepOrphans` reconciles the tree
 * against the table, since a file and its row are not written transactionally
 * together and a crash between the two leaves a file nothing will ever delete.
 *
 * All three run here rather than on a schedule of their own. One sweep is one
 * schedule to reason about, and body rows expiring on a different tick from the
 * request logs they belong to would leave an artifact whose log has gone.
 */
export async function pruneLogs(
  store: Store,
  now: number,
): Promise<{
  raw: number;
  daily: number;
  quotaSamples: number;
  bodies: number;
  bodiesOverCap: number;
  bodyOrphans: number;
}> {
  const settings = await store.config.getSettings();
  const rawHorizon = now - settings.logRetentionDays * DAY_MS;
  const raw = await store.usage.prune(rawHorizon);
  const daily = await store.usage.pruneDaily(now - ROLLUP_RETENTION_DAYS * DAY_MS);
  const quotaSamples = await store.credentials.pruneQuotaSamples(rawHorizon);
  const bodies = await store.bodies.prune(rawHorizon);
  const bodiesOverCap = await store.bodies.pruneToCap();
  const bodyOrphans = await store.bodies.sweepOrphans();
  return { raw, daily, quotaSamples, bodies, bodiesOverCap, bodyOrphans };
}

/**
 * The half of the sweep that removes files rather than rows.
 *
 * Snapshot retention is the approved design's "applied after every create and
 * on the existing maintenance sweep", and only the first half of that was ever
 * wired: with the create path as its sole caller, `maxAgeDays` expires nothing
 * on an installation that stopped taking snapshots and a lowered `keepLatest`
 * prunes nothing until somebody takes another one — while the panel tells the
 * operator both apply hourly.
 *
 * The staging sweep rides along for the same reason the three body sweeps ride
 * along with the log prune: one schedule to reason about. It is bounded
 * cleanup, and the files it removes are database-sized.
 */
export async function pruneFiles(
  deps: DatabaseDeps,
): Promise<{ snapshots: number; staging: number }> {
  return { snapshots: await pruneSnapshots(deps), staging: sweepStaging(deps) };
}

export type MaintenanceDeps = {
  store: Store;
  now: () => number;
  logger?: Logger;
  /** The filesystem the file sweeps run against. The real one, unless a test says otherwise. */
  fs?: DatabaseDeps["fs"];
};

/** Starts the hourly sweep. Returns a function that stops it. */
export function startMaintenance(deps: MaintenanceDeps): () => void {
  const logger = deps.logger ?? noopLogger;
  const files: DatabaseDeps = {
    store: deps.store,
    fs: deps.fs ?? nodeDatabaseFs(),
    now: deps.now,
  };

  const timer = setInterval(() => {
    void pruneFiles(files)
      .then(({ snapshots, staging }) =>
        // One number, under a field `LogFields` already has, for the same
        // reason the three body sweeps share one: this type is the compile-time
        // redaction boundary and not somewhere to widen for a debug line.
        logger.debug("snapshots and staging files swept", { count: snapshots + staging }),
      )
      .catch((error: unknown) => {
        logger.error("snapshot sweeping failed", {
          reason: describeError(error, "unknown"),
        });
      });

    void pruneLogs(deps.store, deps.now())
      .then(({ raw, daily, quotaSamples, bodies, bodiesOverCap, bodyOrphans }) =>
        logger.debug("request logs pruned", {
          rawCount: raw,
          dailyCount: daily,
          quotaSampleCount: quotaSamples,
          // One number for all three body sweeps, under a field `LogFields`
          // already has. Splitting them would mean widening that type, and it
          // is the compile-time redaction boundary that keeps prompts out of
          // stdout — not somewhere to add a field for the convenience of a
          // debug line. Artifacts removed is what an operator watching disk
          // wants; which of the three sweeps removed one is a question the
          // return value answers.
          count: bodies + bodiesOverCap + bodyOrphans,
        }),
      )
      .catch((error: unknown) => {
        logger.error("log pruning failed", {
          reason: describeError(error, "unknown"),
        });
      });
  }, SWEEP_INTERVAL_MS);

  // Do not hold the process open for a maintenance timer.
  timer.unref?.();

  return () => clearInterval(timer);
}
