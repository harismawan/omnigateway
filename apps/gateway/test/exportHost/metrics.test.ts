import { expect, test } from "bun:test";
import type { DestinationStatus, WorkerMessage } from "../../src/export/protocol.ts";
import { createExportMetrics } from "../../src/exportHost/metrics.ts";
import { createMetricRegistry } from "../../src/telemetry/registry.ts";
import { renderPrometheus } from "../../src/telemetry/render.ts";

/**
 * The fold from worker status into Prometheus. Design: *Worker protocol*
 * (status folded "scalar sets only") and *Observability*. Counters in a
 * status are per worker instance, so the fold keeps a baseline per instance:
 * a restarted worker reporting from zero never lowers a total and never
 * counts what the last instance already reported.
 */

type Counters = DestinationStatus["counters"];
const ZERO: Counters = {
  recordsSent: 0,
  recordsDropped: 0,
  batchesOk: 0,
  batchesRetry: 0,
  batchesFailed: 0,
  gapWarnings: 0,
};

function dest(id: string, counters: Partial<Counters>, lagMs: number | null = 12_000) {
  return {
    id,
    generation: `gen-${id}`,
    type: "webhook" as const,
    enabled: true,
    lagMs,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    exportedTotal: 0,
    droppedTotal: 0,
    gapPossibleAt: null,
    skipRequestedAt: null,
    retryAt: null,
    failing: false,
    counters: { ...ZERO, ...counters },
  } satisfies DestinationStatus;
}

const status = (
  ...destinations: DestinationStatus[]
): Extract<WorkerMessage, { type: "status" }> => ({
  type: "status",
  at: 0,
  destinations,
});

function setup() {
  const registry = createMetricRegistry({ maxSeries: 100, now: () => 0 });
  const metrics = createExportMetrics(registry);
  const value = (name: Parameters<typeof registry.value>[0], labels: Record<string, string>) =>
    registry.value(name, labels);
  return { registry, metrics, value };
}

test("counters fold as increases within one instance", () => {
  const { metrics, value } = setup();
  metrics.instanceStarted();
  metrics.fold(status(dest("es", { recordsSent: 5, batchesOk: 1 })));
  metrics.fold(
    status(dest("es", { recordsSent: 12, recordsDropped: 1, batchesOk: 2, batchesRetry: 1 })),
  );
  expect(value("omni_export_records_total", { destination: "es", outcome: "sent" })).toBe(12);
  expect(value("omni_export_records_total", { destination: "es", outcome: "dropped" })).toBe(1);
  expect(value("omni_export_batches_total", { destination: "es", outcome: "ok" })).toBe(2);
  expect(value("omni_export_batches_total", { destination: "es", outcome: "retry" })).toBe(1);
  expect(value("omni_export_batches_total", { destination: "es", outcome: "failed" })).toBe(0);
  expect(value("omni_export_lag_seconds", { destination: "es" })).toBe(12);
});

test("a restarted worker starting from zero never lowers or double-counts a total", () => {
  const { metrics, value } = setup();
  metrics.instanceStarted();
  metrics.fold(status(dest("es", { recordsSent: 10, gapWarnings: 1 })));
  // The same instance repeating itself adds nothing.
  metrics.fold(status(dest("es", { recordsSent: 10, gapWarnings: 1 })));
  expect(value("omni_export_records_total", { destination: "es", outcome: "sent" })).toBe(10);

  // A new instance reports from zero; its first status counts in full.
  metrics.instanceStarted();
  metrics.fold(status(dest("es", { recordsSent: 0 })));
  expect(value("omni_export_records_total", { destination: "es", outcome: "sent" })).toBe(10);
  metrics.fold(status(dest("es", { recordsSent: 3, gapWarnings: 1 })));
  expect(value("omni_export_records_total", { destination: "es", outcome: "sent" })).toBe(13);
  expect(value("omni_export_gap_warnings_total", { destination: "es" })).toBe(2);
});

test("a delete-and-recreate under the same id continues the id's series from the new generation", () => {
  const { metrics, value } = setup();
  metrics.instanceStarted();
  metrics.fold(status(dest("es", { recordsSent: 4 })));
  // Same instance, same id, new generation: its counters start at zero.
  metrics.fold(status({ ...dest("es", { recordsSent: 1 }), generation: "gen-es-2" }));
  expect(value("omni_export_records_total", { destination: "es", outcome: "sent" })).toBe(5);
});

test("restarts are a set scalar, and removed destinations' series are dropped", () => {
  const { registry, metrics, value } = setup();
  metrics.instanceStarted();
  metrics.fold(status(dest("es", { recordsSent: 1 }), dest("hook", { recordsSent: 2 })));
  metrics.restarts(3);
  expect(value("omni_export_worker_restarts_total", {})).toBe(3);

  metrics.fold(status(dest("es", { recordsSent: 1 })));
  const text = renderPrometheus(registry.snapshot());
  expect(text).toContain('omni_export_records_total{destination="es",outcome="sent"} 1');
  expect(text).not.toContain('destination="hook"');
  expect(text).toContain("# TYPE omni_export_worker_restarts_total counter");
  expect(text).toContain("# TYPE omni_export_lag_seconds gauge");
});

test("a destination with no state row yet has no lag sample", () => {
  const { registry, metrics } = setup();
  metrics.instanceStarted();
  metrics.fold(status(dest("es", {}, null)));
  const text = renderPrometheus(registry.snapshot());
  expect(text).not.toContain("omni_export_lag_seconds{");
});
