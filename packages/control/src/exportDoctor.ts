import type { ExportStatusDestination, ExportStatusRow } from "@omni/store/exportStatus";

/**
 * What `omni doctor` says about log export, from what the CLI can read
 * without the gateway: the destinations and the worker's state rows, both
 * read-only. Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Observability*: lag over an hour, failing over 15 minutes; *Failure
 * isolation*: worker down; *Cursor*: the gap warning until acknowledged).
 *
 * Pure: the caller supplies `now` and whether the gateway is running. The
 * worker lives inside the gateway and the CLI cannot see it, so "worker
 * down" is judged the way `doctor` judges every gateway-only fact: from the
 * process — enabled destinations and no gateway means nothing exports them.
 * `gatewayRunning: null` (a cluster, whose replicas the CLI does not
 * supervise) makes no such claim. A worker the running gateway gave up on
 * (five deaths in ten minutes) shows in the console and on `/metrics`.
 *
 * **Failing** is judged without inventing a duration. The state holds the
 * last error and the last instants the destination was known healthy — its
 * last delivery (`last_success_at`), its last caught-up idle pass
 * (`caught_up_through`), and its last edit (`updatedAt`, which a fix or a
 * re-enable moves). A destination is failing when its last error is more
 * than 15 minutes after the latest of those: it has had no good news for
 * that long while erroring. An idle destination's caught-up passes keep that
 * instant fresh, so one new error after hours of quiet is not "failing for
 * hours".
 */

const DOCTOR_LAG_MS = 60 * 60 * 1000;
const DOCTOR_FAILING_MS = 15 * 60 * 1000;

export type ExportDoctor = {
  /** Null when the destinations themselves could not be read. */
  destinations: number | null;
  /** `unavailable`: nothing to warn about, but the state could not be read. */
  status: "none" | "ok" | "warnings" | "unavailable";
  /** False: "export status unavailable", reported beside any warnings rather than hidden by them. */
  available: boolean;
  warnings: string[];
};

const GAP =
  "export is within a day of log retention or past it; rows may have been pruned before export";

const minutes = (ms: number): number => Math.floor(ms / 60_000);

export function exportDoctor(
  destinations: readonly ExportStatusDestination[] | null,
  states: readonly ExportStatusRow[] | null,
  ctx: { now: number; gatewayRunning: boolean | null },
): ExportDoctor {
  if (destinations === null) {
    return { destinations: null, status: "unavailable", available: false, warnings: [] };
  }
  if (destinations.length === 0) {
    return { destinations: 0, status: "none", available: true, warnings: [] };
  }
  const warnings: string[] = [];
  if (ctx.gatewayRunning === false && destinations.some((d) => d.enabled)) {
    warnings.push("export worker down: the gateway is not running");
  }
  const byGeneration = new Map((states ?? []).map((s) => [s.generation, s]));
  for (const d of destinations) {
    // No row yet: the worker has not looked at it, which is not a fault.
    const s = byGeneration.get(d.generation);
    if (s === undefined) continue;
    if (s.gapPossibleAt !== null) warnings.push(`${d.id}: ${GAP}`);
    if (!d.enabled) continue;
    const lag = ctx.now - Math.max(s.cursorAt, s.caughtUpThrough);
    if (lag > DOCTOR_LAG_MS) warnings.push(`${d.id}: ${minutes(lag)} min behind`);
    if (s.lastError === null || s.lastErrorAt === null) continue;
    const healthyAt = Math.max(s.lastSuccessAt ?? 0, s.caughtUpThrough, d.updatedAt);
    const unhealthyFor = s.lastErrorAt - healthyAt;
    if (unhealthyFor > DOCTOR_FAILING_MS) {
      warnings.push(
        `${d.id}: failing (${s.lastError}): no successful delivery in the ${minutes(unhealthyFor)} min up to its last error`,
      );
    }
  }
  const available = states !== null;
  return {
    destinations: destinations.length,
    status: warnings.length > 0 ? "warnings" : available ? "ok" : "unavailable",
    available,
    warnings,
  };
}
