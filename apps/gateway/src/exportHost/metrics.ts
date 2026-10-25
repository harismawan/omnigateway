import type { DestinationCounters, WorkerMessage } from "../export/protocol.ts";
import type { MetricLabels, MetricName, MetricRegistry } from "../telemetry/registry.ts";

/**
 * Folds the export worker's status messages into the Prometheus registry.
 * Design: docs/superpowers/specs/2026-10-24-log-export-design.md (*Worker
 * protocol* → status, *Observability*). Scalar adds and sets only: nothing
 * here reads a store.
 *
 * A status carries counters **per worker instance** — monotonic while that
 * instance lives, zero in a newly spawned one — so the fold keeps a baseline
 * per instance, keyed by destination generation, and adds only the increase
 * over it. `instanceStarted` resets the baseline on every spawn: a restart
 * never lowers a total and never counts again what the dead instance had
 * already reported. Series are labelled by destination id (≤ 10, the
 * destination cap); a delete-and-recreate under one id continues that id's
 * series from the new generation's zero.
 */
export type ExportMetrics = {
  /** A new worker instance was spawned: its counters start at zero. */
  instanceStarted(): void;
  fold(status: Extract<WorkerMessage, { type: "status" }>): void;
  /** Drops every series of a destination not in `ids` (removed ones). */
  retain(ids: ReadonlySet<string>): void;
  /** `omni_export_worker_restarts_total`, owned by the supervisor and set whole. */
  restarts(total: number): void;
};

const COUNTERS: ReadonlyArray<{
  key: keyof DestinationCounters;
  name: MetricName;
  outcome?: string;
}> = [
  { key: "recordsSent", name: "omni_export_records_total", outcome: "sent" },
  { key: "recordsDropped", name: "omni_export_records_total", outcome: "dropped" },
  { key: "batchesOk", name: "omni_export_batches_total", outcome: "ok" },
  { key: "batchesRetry", name: "omni_export_batches_total", outcome: "retry" },
  { key: "batchesFailed", name: "omni_export_batches_total", outcome: "failed" },
  { key: "gapWarnings", name: "omni_export_gap_warnings_total" },
];

const PER_DESTINATION: readonly MetricName[] = [
  "omni_export_records_total",
  "omni_export_batches_total",
  "omni_export_lag_seconds",
  "omni_export_gap_warnings_total",
];

export function createExportMetrics(registry: MetricRegistry): ExportMetrics {
  let baseline = new Map<string, DestinationCounters>();

  const retain = (ids: ReadonlySet<string>): void => {
    const gone = (labels: MetricLabels): boolean =>
      labels.destination !== undefined && !ids.has(labels.destination);
    for (const name of PER_DESTINATION) registry.drop(name, gone);
  };

  return {
    instanceStarted() {
      baseline = new Map();
    },
    fold(status) {
      const next = new Map<string, DestinationCounters>();
      for (const d of status.destinations) {
        const last = baseline.get(d.generation);
        for (const { key, name, outcome } of COUNTERS) {
          const labels =
            outcome === undefined ? { destination: d.id } : { destination: d.id, outcome };
          // Touched even at zero, so every outcome series exists from the first status.
          registry.add(name, labels, Math.max(0, d.counters[key] - (last?.[key] ?? 0)));
        }
        if (d.lagMs === null) {
          registry.drop("omni_export_lag_seconds", (labels) => labels.destination === d.id);
        } else {
          registry.set("omni_export_lag_seconds", { destination: d.id }, d.lagMs / 1000);
        }
        next.set(d.generation, { ...d.counters });
      }
      baseline = next;
      retain(new Set(status.destinations.map((d) => d.id)));
    },
    retain,
    restarts(total) {
      registry.set("omni_export_worker_restarts_total", {}, total);
    },
  };
}
