import { expect, test } from "bun:test";
import { createMetricRegistry } from "../../src/telemetry/registry.ts";
import { renderPrometheus } from "../../src/telemetry/render.ts";

test("renders Prometheus metadata, histograms, and escaped labels", () => {
  const registry = createMetricRegistry({ maxSeries: 50, now: () => 1_000 });
  registry.add("omni_requests_total", {
    provider: "anthropic",
    model: 'claude\\"\nnext',
    status: "200",
    code: "",
    api_key_id: "key_1",
  });
  registry.observe("omni_request_duration_seconds", 0.2, {
    provider: "anthropic",
    model: 'claude\\"\nnext',
  });

  const text = renderPrometheus(registry.snapshot());
  expect(text).toContain("# HELP omni_requests_total Requests completed by this process.");
  expect(text).toContain("# TYPE omni_requests_total counter");
  expect(text).toContain('model="claude\\\\\\"\\nnext"');
  expect(text).toContain("# TYPE omni_request_duration_seconds histogram");
  expect(text).toContain('omni_request_duration_seconds_bucket{provider="anthropic",model="claude');
  expect(text.endsWith("\n")).toBe(true);
});

test("folds new API key series past the cap without dropping totals", () => {
  const registry = createMetricRegistry({ maxSeries: 3, now: () => 0 });
  for (const key of ["key_1", "key_2", "key_3", "key_4"]) {
    registry.add("omni_cost_usd_total", { provider: "openai", model: "gpt-5", api_key_id: key }, 2);
  }

  const samples = registry
    .snapshot()
    .metrics.find((metric) => metric.name === "omni_cost_usd_total")?.samples;
  expect(samples?.reduce((sum, sample) => sum + sample.value, 0)).toBe(8);
  expect(samples?.some((sample) => sample.labels.api_key_id === "other")).toBe(true);
  expect(registry.value("omni_metrics_series_folded_total", {})).toBe(1);
});
