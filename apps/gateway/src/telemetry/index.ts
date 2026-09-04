import type { ErrorCode, Logger, ProviderId } from "@omni/ir";
import type { RequestLog } from "@omni/store";
import type { RegistryStats } from "../stream/registry.ts";
import { createOtlpExporter, type OtlpExporter } from "./otlp.ts";
import { createMetricRegistry, type MetricRegistry } from "./registry.ts";
import { renderPrometheus } from "./render.ts";
import { addSpan, createTrace, parseTraceparent, type TraceRecord } from "./spans.ts";

export type HttpHead = {
  provider: ProviderId;
  host: string;
  path: string;
  status?: number;
  durationMs: number;
  requestId?: string;
};

export type Telemetry = {
  readonly metricsEnabled: boolean;
  readonly tracingEnabled: boolean;
  readonly registry: MetricRegistry;
  startRequest(
    requestId: string,
    startedAt: number,
    traceparent: string | null,
    surface: "anthropic" | "openai" | "responses",
    rand: number,
  ): TraceRecord | null;
  record(log: RequestLog, keyId: string | null, trace: TraceRecord | null): void;
  flush(requestId: string, trace: TraceRecord | null): void;
  httpHead(event: HttpHead): void;
  breaker(
    provider: ProviderId,
    before: "closed" | "open" | "halfOpen",
    after: "closed" | "open" | "halfOpen",
  ): void;
  rateLimit(dimension: string, window: string | null): void;
  scrape(
    localInflight: ReadonlyMap<ProviderId, number>,
    streams: RegistryStats,
    coordFallback: boolean,
  ): string;
  stop(): void;
};

export function parseOtlpHeaders(value: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (value === null) return headers;
  for (const entry of value.split(",")) {
    const at = entry.indexOf("=");
    if (at <= 0) continue;
    const key = entry.slice(0, at).trim();
    if (key.length > 0) headers[key] = entry.slice(at + 1).trim();
  }
  return headers;
}

export function createTelemetry(opts: {
  metricsEnabled: boolean;
  maxSeries: number;
  otlpEndpoint: string | null;
  otlpHeaders: Readonly<Record<string, string>>;
  traceSample: number;
  now: () => number;
  version: string;
  logger?: Logger;
  exporter?: OtlpExporter;
}): Telemetry {
  const registry = createMetricRegistry({ maxSeries: opts.maxSeries, now: opts.now });
  const traces = new Map<string, TraceRecord>();
  const openBreakers = new Map<ProviderId, number>();
  const exporter =
    opts.exporter ??
    (opts.otlpEndpoint === null
      ? null
      : createOtlpExporter({
          endpoint: opts.otlpEndpoint,
          headers: opts.otlpHeaders,
          capacity: 10_000,
          batchMax: 512,
          intervalMs: 5_000,
          registry,
          ...(opts.logger === undefined ? {} : { logger: opts.logger }),
          version: opts.version,
        }));
  if (opts.metricsEnabled) registry.set("omni_build_info", { version: opts.version }, 1);

  return {
    metricsEnabled: opts.metricsEnabled,
    tracingEnabled: exporter !== null,
    registry,
    startRequest(requestId, startedAt, traceparent, surface, rand) {
      if (exporter === null) return null;
      const inbound = parseTraceparent(traceparent);
      if (inbound !== null ? !inbound.sampled : rand >= opts.traceSample) return null;
      const trace = createTrace({ startedAt, traceparent: inbound });
      addSpan(trace, "gateway.request", null, 0, 0, { surface });
      traces.set(requestId, trace);
      return trace;
    },
    record(log, keyId, trace) {
      if (opts.metricsEnabled) {
        const provider = log.resolvedProvider ?? "";
        const model = log.resolvedModel ?? log.requestedModel;
        const key = keyId ?? "";
        registry.add("omni_requests_total", {
          provider,
          model,
          status: String(log.status),
          code: log.errorCode ?? "",
          api_key_id: key,
        });
        registry.observe("omni_request_duration_seconds", log.durationMs / 1000, {
          provider,
          model,
        });
        if (log.ttftMs !== null)
          registry.observe("omni_ttft_seconds", log.ttftMs / 1000, { provider, model });
        for (const [kind, value] of [
          ["input", log.inputTokens],
          ["output", log.outputTokens],
          ["cache_read", log.cacheReadTokens],
          ["cache_write", log.cacheWriteTokens],
        ] as const) {
          registry.add("omni_tokens_total", { provider, model, api_key_id: key, kind }, value);
        }
        registry.add("omni_cost_usd_total", { provider, model, api_key_id: key }, log.costUsd);
      }
      if (trace !== null) {
        const root = trace.spans[0];
        if (root !== undefined) {
          root.endMs = log.durationMs;
          root.attrs = {
            ...root.attrs,
            requested_model: log.requestedModel,
            api_key_id: keyId ?? "",
            status: log.status,
            ...(log.errorCode === null ? {} : { code: log.errorCode as ErrorCode | "interrupted" }),
          };
        }
      }
    },
    flush(requestId, trace) {
      traces.delete(requestId);
      if (trace !== null) exporter?.enqueue(trace);
    },
    httpHead(event) {
      if (opts.metricsEnabled)
        registry.observe("omni_upstream_duration_seconds", event.durationMs / 1000, {
          provider: event.provider,
        });
      const trace = event.requestId === undefined ? undefined : traces.get(event.requestId);
      if (trace === undefined) return;
      const endMs = Math.max(0, opts.now() - trace.startedAt);
      addSpan(
        trace,
        "provider.http",
        trace.activeAttempt ?? null,
        Math.max(0, endMs - event.durationMs),
        endMs,
        {
          provider: event.provider,
          host: event.host,
          path: event.path,
          ...(event.status === undefined ? {} : { status: event.status }),
        },
      );
    },
    breaker(provider, before, after) {
      if (!opts.metricsEnabled || before === after) return;
      const count = Math.max(
        0,
        (openBreakers.get(provider) ?? 0) + (after === "open" ? 1 : before === "open" ? -1 : 0),
      );
      openBreakers.set(provider, count);
      registry.set("omni_breaker_open", { provider }, count);
    },
    rateLimit(dimension, window) {
      if (opts.metricsEnabled)
        registry.add("omni_ratelimit_rejected_total", { dimension, window: window ?? "none" });
    },
    scrape(localInflight, streams, coordFallback) {
      for (const [provider, value] of localInflight)
        registry.set("omni_inflight", { provider }, value);
      registry.set("omni_stream_connections", {}, streams.connections);
      registry.set("omni_stream_queued", {}, streams.queued);
      registry.set("omni_stream_dropped_total", {}, streams.dropped);
      registry.set("omni_coord_fallback", {}, coordFallback ? 1 : 0);
      return renderPrometheus(registry.snapshot());
    },
    stop() {
      exporter?.stop();
    },
  };
}
