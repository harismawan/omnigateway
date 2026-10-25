import type { ExportDestination } from "@omni/store";
import type { ExportStatusRow } from "@omni/store/exportStatus";

/**
 * What `omni doctor` says about log export, from what the CLI can read
 * without the gateway: the destinations (the store) and the worker's state
 * rows (read-only). Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Observability*: lag over an hour, failing over 15 minutes; *Failure
 * isolation*: worker down; *Cursor*: the gap warning until acknowledged).
 *
 * Pure: the caller supplies `now` and whether the gateway is running. The
 * worker lives inside the gateway and the CLI cannot see it, so "worker
 * down" is judged the way `doctor` judges every gateway-only fact: from the
 * process — enabled destinations and no gateway means nothing exports them.
 * A worker the running gateway gave up on (five deaths in ten minutes) shows
 * in the console and on `/metrics`, not here.
 */

const DOCTOR_LAG_MS = 60 * 60 * 1000;
const DOCTOR_FAILING_MS = 15 * 60 * 1000;

export type ExportDoctor = {
  destinations: number;
  /** `unavailable`: the state could not be read ("export status unavailable"). */
  status: "none" | "ok" | "warnings" | "unavailable";
  warnings: string[];
};

const GAP =
  "export is within a day of log retention or past it; rows may have been pruned before export";

const minutes = (ms: number): number => Math.floor(ms / 60_000);

export function exportDoctor(
  destinations: readonly ExportDestination[],
  states: readonly ExportStatusRow[] | null,
  ctx: { now: number; gatewayRunning: boolean },
): ExportDoctor {
  if (destinations.length === 0) return { destinations: 0, status: "none", warnings: [] };
  const warnings: string[] = [];
  if (!ctx.gatewayRunning && destinations.some((d) => d.enabled)) {
    warnings.push("export worker down: the gateway is not running");
  }
  if (states === null) {
    return {
      destinations: destinations.length,
      status: warnings.length > 0 ? "warnings" : "unavailable",
      warnings,
    };
  }
  const byGeneration = new Map(states.map((s) => [s.generation, s]));
  for (const d of destinations) {
    // No row yet: the worker has not looked at it, which is not a fault.
    const s = byGeneration.get(d.generation);
    if (s === undefined) continue;
    if (s.gapPossibleAt !== null) warnings.push(`${d.id}: ${GAP}`);
    if (!d.enabled) continue;
    const lag = ctx.now - Math.max(s.cursorAt, s.caughtUpThrough);
    if (lag > DOCTOR_LAG_MS) warnings.push(`${d.id}: ${minutes(lag)} min behind`);
    const failing =
      s.lastError !== null &&
      s.lastErrorAt !== null &&
      (s.lastSuccessAt === null || s.lastErrorAt > s.lastSuccessAt);
    if (failing) {
      const since = ctx.now - (s.lastSuccessAt ?? d.createdAt);
      if (since > DOCTOR_FAILING_MS) {
        warnings.push(`${d.id}: failing for ${minutes(since)} min (${s.lastError})`);
      }
    }
  }
  return {
    destinations: destinations.length,
    status: warnings.length > 0 ? "warnings" : "ok",
    warnings,
  };
}
