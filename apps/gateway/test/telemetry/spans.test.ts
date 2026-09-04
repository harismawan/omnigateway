import { expect, test } from "bun:test";
import { createTelemetry } from "../../src/telemetry/index.ts";
import { createOtlpExporter } from "../../src/telemetry/otlp.ts";
import { createMetricRegistry } from "../../src/telemetry/registry.ts";
import {
  addSpan,
  createTrace,
  encodeTrace,
  parseTraceparent,
  type SpanAttrs,
} from "../../src/telemetry/spans.ts";

test("joins a valid traceparent and ignores malformed input", () => {
  const valid = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  expect(valid).toEqual({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    parentSpanId: "00f067aa0ba902b7",
    sampled: true,
  });
  expect(parseTraceparent("garbage")).toBeNull();
  expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();

  const trace = createTrace({ startedAt: 1_000, traceparent: valid, id: () => "1111111111111111" });
  addSpan(trace, "gateway.request", null, 0, 10, { surface: "openai", status: 200 });
  const encoded = encodeTrace(trace, "test");
  expect(encoded.resourceSpans[0]?.scopeSpans[0]?.spans[0]).toMatchObject({
    traceId: valid?.traceId,
    parentSpanId: valid?.parentSpanId,
  });
});

test("span attributes remain a closed allowlist", () => {
  const trace = createTrace({ startedAt: 0, traceparent: null, id: () => "1111111111111111" });
  const legitimate: SpanAttrs = { provider: "anthropic", status: 200 };
  addSpan(trace, "provider.http", null, 0, 1, legitimate);
  const wider = { provider: "anthropic", prompt: "secret" };
  // @ts-expect-error - prompt is not a member of SpanAttrs
  addSpan(trace, "provider.http", null, 0, 1, wider);
  // @ts-expect-error - a conditional spread must not bypass the allowlist
  addSpan(trace, "provider.http", null, 0, 1, { provider: "anthropic", ...{ prompt: "secret" } });
  expect(trace.spans).toHaveLength(3);
});

test("a bounded exporter drops newest spans and counts queue and encode failures", () => {
  const registry = createMetricRegistry({ maxSeries: 20, now: () => 0 });
  const exporter = createOtlpExporter({
    endpoint: "https://collector.example",
    headers: {},
    capacity: 1,
    batchMax: 1,
    intervalMs: 1_000,
    registry,
    fetch: async () => new Response(null, { status: 200 }),
    schedule: () => () => {},
  });
  const trace = createTrace({ startedAt: 0, traceparent: null, id: () => "1111111111111111" });
  addSpan(trace, "gateway.request", null, 0, 1, {});

  expect(() => {
    exporter.enqueue(trace);
    exporter.enqueue(trace);
  }).not.toThrow();
  expect(exporter.queued()).toBe(1);
  expect(registry.value("omni_otlp_spans_dropped_total", { reason: "queue_full" })).toBe(1);

  exporter.enqueue({ ...trace, spans: [{ ...trace.spans[0], attrs: { broken: 1n } }] } as never);
  expect(registry.value("omni_otlp_spans_dropped_total", { reason: "encode" })).toBe(1);
  exporter.stop();
});

test("tracing off allocates no trace, even for a sampled inbound traceparent", () => {
  const telemetry = createTelemetry({
    metricsEnabled: false,
    maxSeries: 10,
    otlpEndpoint: null,
    otlpHeaders: {},
    traceSample: 1,
    now: () => 0,
    version: "test",
  });
  expect(telemetry.tracingEnabled).toBe(false);
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  expect(telemetry.startRequest("req_1", 0, traceparent, "openai", 0)).toBeNull();
  telemetry.stop();
});
