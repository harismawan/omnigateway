import { expect, test } from "bun:test";
import { writerMetricsVerdict } from "./surface-accepted.ts";

const frozen = '200\ncontent-length: <len>\ncontent-type: text/plain\n\nexisting{key="a"} 1\n';
const suffix = [
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
  "",
].join("\n");

test("only the exact writer suffix is accepted on a named authenticated GET", () => {
  const verdict = (rust: string) => writerMetricsVerdict("full", "boot metrics ok", frozen, rust);
  const rust = frozen + suffix;
  expect(verdict(rust)).toBe("rust-writer-metrics-additive");
  expect(verdict(frozen)).toBe("unexpected");
  expect(verdict(rust.replace('reason="cap"', 'reason="other"'))).toBe("unexpected");
  expect(verdict(rust.replace("text/plain", "application/json"))).toBe("unexpected");
  expect(verdict(rust.replace("200\n", "401\n"))).toBe("unexpected");
  expect(verdict(rust.replace('existing{key="a"}', 'existing{key="b"}'))).toBe("unexpected");
  expect(verdict(rust + "omni_request_log_writer_queued 0\n")).toBe("unexpected");
  expect(verdict(rust + "# HELP omni_request_log_writer_sink_dropped_total unexpected\n")).toBe(
    "unexpected",
  );
  expect(verdict(frozen + suffix.split("\n").reverse().join("\n"))).toBe("unexpected");
  expect(writerMetricsVerdict("full", "boot metrics none", frozen, rust)).toBeNull();
});
