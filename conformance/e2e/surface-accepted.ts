// One accepted surface divergence, limited to the 14 authenticated single-mode GETs.
// D4 fix1 brief, P2 #3 (`c62ce332`, merged in `7c2d7adc`): fixed writer loss counters.
// P1 brief, gate 6 (`2c502ce4`): fixed reservation-refusal causes. P1 pressure gauges
// (`37adaaee`) are cluster-only and therefore not allowed in these single-mode rows.
const writerMetrics = {
  id: "rust-writer-metrics-additive",
  rows: {
    full: [
      "boot metrics ok",
      "boot metrics query",
      "boot metrics slash",
      "boot metrics dotdot",
      "after metrics ok",
      "after metrics query",
      "after metrics slash",
      "after metrics dotdot",
    ],
    cap: ["cap metrics ok", "cap metrics query", "cap metrics slash", "cap metrics dotdot"],
    cancel: ["cancel metrics after deadline"],
    abort: ["cancel metrics after abort"],
  },
  lines: [
    "# TYPE omni_request_log_writer_terminal_dropped_total counter",
    "omni_request_log_writer_terminal_dropped_total 0",
    "# TYPE omni_request_log_writer_optional_dropped_total counter",
    "omni_request_log_writer_optional_dropped_total 0",
    "# TYPE omni_request_log_writer_failed_batches_total counter",
    "omni_request_log_writer_failed_batches_total 0",
    "# TYPE omni_request_log_writer_failed_events_total counter",
    "omni_request_log_writer_failed_events_total 0",
    "# TYPE omni_request_log_writer_sink_dropped_total counter",
    "omni_request_log_writer_sink_dropped_total 0",
    "# TYPE omni_request_log_writer_reservation_refused_total counter",
    'omni_request_log_writer_reservation_refused_total{reason="cap"} 0',
    'omni_request_log_writer_reservation_refused_total{reason="deadline"} 0',
    'omni_request_log_writer_reservation_refused_total{reason="closed"} 0',
    'omni_request_log_writer_reservation_refused_total{reason="revalidation"} 0',
  ],
} as const;

/** The exporter emits TYPE, not HELP, for these families. Pin the exact suffix,
 * including order, label sets, values for this fixture and final newline. */
export function writerMetricsVerdict(
  config: string,
  row: string,
  frozen: string,
  rust: string,
): "rust-writer-metrics-additive" | "unexpected" | null {
  if (!Object.hasOwn(writerMetrics.rows, config)) return null;
  const rows: readonly string[] = writerMetrics.rows[config as keyof typeof writerMetrics.rows];
  if (!rows.includes(row)) return null;

  const suffix = `${writerMetrics.lines.join("\n")}\n`;
  // Compare the entire original normalized exchange, not just a set of series.
  // normalize() already checks the actual Content-Length before masking it.
  return frozen.startsWith("200\n") && rust === frozen + suffix ? writerMetrics.id : "unexpected";
}
