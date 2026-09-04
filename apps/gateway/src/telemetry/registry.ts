export type MetricName =
  | "omni_requests_total"
  | "omni_request_duration_seconds"
  | "omni_ttft_seconds"
  | "omni_tokens_total"
  | "omni_cost_usd_total"
  | "omni_upstream_duration_seconds"
  | "omni_inflight"
  | "omni_breaker_open"
  | "omni_ratelimit_rejected_total"
  | "omni_stream_connections"
  | "omni_stream_queued"
  | "omni_stream_dropped_total"
  | "omni_coord_fallback"
  | "omni_metrics_series_folded_total"
  | "omni_otlp_spans_dropped_total"
  | "omni_build_info";

export type MetricLabels = Readonly<Record<string, string>>;
export type MetricSample = { labels: MetricLabels; value: number };
export type HistogramSample = MetricSample & {
  count: number;
  sum: number;
  buckets: readonly number[];
};

export type MetricSnapshot = {
  at: number;
  metrics: readonly {
    name: MetricName;
    help: string;
    type: "counter" | "gauge" | "histogram";
    samples: readonly (MetricSample | HistogramSample)[];
  }[];
};

export type MetricRegistry = {
  add(name: MetricName, labels: MetricLabels, value?: number): void;
  set(name: MetricName, labels: MetricLabels, value: number): void;
  observe(name: MetricName, value: number, labels: MetricLabels): void;
  value(name: MetricName, labels: MetricLabels): number;
  snapshot(): MetricSnapshot;
};

const DEFINITIONS: Readonly<
  Record<MetricName, { help: string; type: "counter" | "gauge" | "histogram" }>
> = {
  omni_requests_total: { help: "Requests completed by this process.", type: "counter" },
  omni_request_duration_seconds: { help: "Request duration in seconds.", type: "histogram" },
  omni_ttft_seconds: { help: "Streaming time to first token in seconds.", type: "histogram" },
  omni_tokens_total: { help: "Billable tokens completed by this process.", type: "counter" },
  omni_cost_usd_total: { help: "Request cost in US dollars.", type: "counter" },
  omni_upstream_duration_seconds: {
    help: "Provider response-head duration in seconds.",
    type: "histogram",
  },
  omni_inflight: { help: "Provider requests in flight in this process.", type: "gauge" },
  omni_breaker_open: { help: "Credential breakers observed open in this process.", type: "gauge" },
  omni_ratelimit_rejected_total: { help: "API-key rate-limit refusals.", type: "counter" },
  omni_stream_connections: { help: "Live stream connections in this process.", type: "gauge" },
  omni_stream_queued: { help: "Stream frames queued in this process.", type: "gauge" },
  omni_stream_dropped_total: { help: "Stream frames dropped in this process.", type: "counter" },
  omni_coord_fallback: {
    help: "Whether this process is using coordination fallback.",
    type: "gauge",
  },
  omni_metrics_series_folded_total: {
    help: "Metric series folded into api_key_id other.",
    type: "counter",
  },
  omni_otlp_spans_dropped_total: { help: "Spans dropped before OTLP export.", type: "counter" },
  omni_build_info: { help: "Gateway build information.", type: "gauge" },
};

const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

type Stored = { labels: Record<string, string>; value: number; count?: number; buckets?: number[] };

function labelKey(labels: MetricLabels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key.length}:${key}${value.length}:${value}`)
    .join("");
}

export function createMetricRegistry(opts: {
  maxSeries: number;
  now: () => number;
}): MetricRegistry {
  const series = new Map<MetricName, Map<string, Stored>>();
  const rawSeries = new Set<string>();
  const folded = new Set<string>();

  const normalize = (name: MetricName, labels: MetricLabels): Record<string, string> => {
    const copy = { ...labels };
    const raw = `${name}:${labelKey(copy)}`;
    if (rawSeries.has(raw)) return copy;
    if (rawSeries.size < opts.maxSeries || copy.api_key_id === undefined) {
      rawSeries.add(raw);
      return copy;
    }
    copy.api_key_id = "other";
    if (!folded.has(raw)) {
      folded.add(raw);
      change("omni_metrics_series_folded_total", {}, 1, false);
    }
    return copy;
  };

  const change = (
    name: MetricName,
    labels: MetricLabels,
    value: number,
    replace: boolean,
  ): Stored => {
    const normalized = normalize(name, labels);
    const key = labelKey(normalized);
    const table = series.get(name) ?? new Map<string, Stored>();
    const current = table.get(key) ?? { labels: normalized, value: 0 };
    current.value = replace ? value : current.value + value;
    table.set(key, current);
    series.set(name, table);
    return current;
  };

  return {
    add(name, labels, value = 1) {
      change(name, labels, value, false);
    },
    set(name, labels, value) {
      change(name, labels, value, true);
    },
    observe(name, value, labels) {
      const current = change(name, labels, value, false);
      current.count = (current.count ?? 0) + 1;
      const buckets = current.buckets ?? HISTOGRAM_BUCKETS.map(() => 0);
      for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
        if (value <= (HISTOGRAM_BUCKETS[i] as number)) buckets[i] = (buckets[i] ?? 0) + 1;
      }
      current.buckets = buckets;
    },
    value(name, labels) {
      return series.get(name)?.get(labelKey(labels))?.value ?? 0;
    },
    snapshot() {
      return {
        at: opts.now(),
        metrics: (Object.entries(DEFINITIONS) as [MetricName, (typeof DEFINITIONS)[MetricName]][])
          .map(([name, definition]) => ({
            name,
            ...definition,
            samples: [...(series.get(name)?.values() ?? [])].map((sample) =>
              definition.type === "histogram"
                ? {
                    labels: sample.labels,
                    value: sample.value,
                    sum: sample.value,
                    count: sample.count ?? 0,
                    buckets: sample.buckets ?? HISTOGRAM_BUCKETS.map(() => 0),
                  }
                : { labels: sample.labels, value: sample.value },
            ),
          }))
          .filter((metric) => metric.samples.length > 0),
      };
    },
  };
}

export { HISTOGRAM_BUCKETS };
