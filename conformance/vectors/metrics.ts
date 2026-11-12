#!/usr/bin/env bun
/**
 * Prometheus registry/renderer vectors from the frozen TS telemetry modules.
 *
 *   bun conformance/vectors/metrics.ts > conformance/vectors/metrics.json
 *
 * Each case is a script of registry operations run against the real
 * `createMetricRegistry` and rendered by the real `renderPrometheus`; the
 * Rust registry replays the same script and must produce the same bytes.
 * Nothing here restates the algorithm.
 */
import {
  createMetricRegistry,
  type MetricLabels,
  type MetricName,
} from "../../apps/gateway/src/telemetry/registry.ts";
import { renderPrometheus } from "../../apps/gateway/src/telemetry/render.ts";

type Op =
  | { op: "add"; name: MetricName; labels: [string, string][]; value?: number | string }
  | { op: "set"; name: MetricName; labels: [string, string][]; value: number | string }
  | { op: "observe"; name: MetricName; labels: [string, string][]; value: number | string };

/** JSON cannot carry non-finite numbers or -0, so those travel as strings. */
function num(v: number | string | undefined): number | undefined {
  if (v === undefined || typeof v === "number") return v;
  return (
    {
      NaN: Number.NaN,
      Infinity: Number.POSITIVE_INFINITY,
      "-Infinity": Number.NEGATIVE_INFINITY,
      "-0": -0,
    }[v] ?? Number(v)
  );
}

function labels(pairs: [string, string][]): MetricLabels {
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) out[k] = v;
  return out;
}

function run(maxSeries: number, ops: Op[]): string {
  const r = createMetricRegistry({ maxSeries, now: () => 0 });
  for (const o of ops) {
    const l = labels(o.labels);
    if (o.op === "add") {
      const v = num(o.value);
      if (v === undefined) r.add(o.name, l);
      else r.add(o.name, l, v);
    } else if (o.op === "set") r.set(o.name, l, num(o.value) as number);
    else r.observe(o.name, num(o.value) as number, l);
  }
  return renderPrometheus(r.snapshot());
}

const completion = (key: string, model: string, status = "200", code = ""): Op[] => [
  {
    op: "add",
    name: "omni_requests_total",
    labels: [
      ["provider", "custom"],
      ["model", model],
      ["status", status],
      ["code", code],
      ["api_key_id", key],
    ],
  },
  {
    op: "observe",
    name: "omni_request_duration_seconds",
    labels: [
      ["provider", "custom"],
      ["model", model],
    ],
    value: 0.012,
  },
  ...(["input", "output", "cache_read", "cache_write"] as const).map(
    (kind, i): Op => ({
      op: "add",
      name: "omni_tokens_total",
      labels: [
        ["provider", "custom"],
        ["model", model],
        ["api_key_id", key],
        ["kind", kind],
      ],
      value: [64, 6, 0, 0][i] as number,
    }),
  ),
  {
    op: "add",
    name: "omni_cost_usd_total",
    labels: [
      ["provider", "custom"],
      ["model", model],
      ["api_key_id", key],
    ],
    value: 0.000076,
  },
];

const cases: { name: string; maxSeries: number; ops: Op[] }[] = [
  { name: "empty", maxSeries: 5000, ops: [] },
  {
    name: "build-info-and-gauges",
    maxSeries: 5000,
    ops: [
      { op: "set", name: "omni_build_info", labels: [["version", "0.0.0-dev"]], value: 1 },
      { op: "set", name: "omni_stream_connections", labels: [], value: 0 },
      { op: "set", name: "omni_stream_queued", labels: [], value: 0 },
      { op: "set", name: "omni_stream_dropped_total", labels: [], value: 0 },
      { op: "set", name: "omni_coord_fallback", labels: [], value: 0 },
      { op: "set", name: "omni_coord_faults_total", labels: [], value: 0 },
      { op: "set", name: "omni_inflight", labels: [["provider", "custom"]], value: 2 },
      { op: "set", name: "omni_inflight", labels: [["provider", "custom"]], value: 0 },
    ],
  },
  {
    name: "definition-order-not-insertion-order",
    maxSeries: 5000,
    ops: [
      { op: "set", name: "omni_build_info", labels: [["version", "1"]], value: 1 },
      {
        op: "add",
        name: "omni_ratelimit_rejected_total",
        labels: [
          ["dimension", "requests"],
          ["window", "1m"],
        ],
      },
      {
        op: "add",
        name: "omni_requests_total",
        labels: [
          ["provider", "p"],
          ["model", "m"],
          ["status", "200"],
          ["code", ""],
          ["api_key_id", "k"],
        ],
      },
      {
        op: "add",
        name: "omni_ratelimit_rejected_total",
        labels: [
          ["dimension", "concurrency"],
          ["window", "none"],
        ],
      },
      {
        op: "add",
        name: "omni_ratelimit_rejected_total",
        labels: [
          ["dimension", "requests"],
          ["window", "1m"],
        ],
      },
    ],
  },
  {
    name: "completions",
    maxSeries: 5000,
    ops: [
      ...completion("key_a", "ok"),
      ...completion("key_b", "ok"),
      ...completion("key_a", "ok"),
      ...completion("", "", "401", "AUTH"),
    ],
  },
  {
    name: "label-order-first-insertion-wins",
    maxSeries: 5000,
    ops: [
      {
        op: "add",
        name: "omni_requests_total",
        labels: [
          ["status", "200"],
          ["provider", "p"],
        ],
        value: 2,
      },
      {
        op: "add",
        name: "omni_requests_total",
        labels: [
          ["provider", "p"],
          ["status", "200"],
        ],
        value: 3,
      },
      {
        op: "add",
        name: "omni_requests_total",
        labels: [
          ["provider", "q"],
          ["status", "200"],
        ],
      },
    ],
  },
  {
    name: "label-escaping",
    maxSeries: 5000,
    ops: [
      {
        op: "add",
        name: "omni_requests_total",
        labels: [
          ["provider", 'quote " back \\ nl \n tab \t cr \r'],
          ["model", "日本語 😀"],
          ["status", "\\n"],
          ["code", "}{,="],
          ["api_key_id", ""],
        ],
      },
    ],
  },
  {
    name: "numbers",
    maxSeries: 5000,
    ops: [
      { op: "add", name: "omni_cost_usd_total", labels: [["k", "a"]], value: 0.1 },
      { op: "add", name: "omni_cost_usd_total", labels: [["k", "a"]], value: 0.2 },
      { op: "add", name: "omni_cost_usd_total", labels: [["k", "b"]], value: 1e21 },
      { op: "add", name: "omni_cost_usd_total", labels: [["k", "c"]], value: 1e-7 },
      { op: "add", name: "omni_cost_usd_total", labels: [["k", "d"]], value: "-0" },
      { op: "add", name: "omni_cost_usd_total", labels: [["k", "e"]], value: "NaN" },
      { op: "add", name: "omni_cost_usd_total", labels: [["k", "f"]], value: "Infinity" },
      { op: "add", name: "omni_cost_usd_total", labels: [["k", "g"]], value: "-Infinity" },
      { op: "add", name: "omni_cost_usd_total", labels: [["k", "h"]], value: 123456789.125 },
      { op: "add", name: "omni_cost_usd_total", labels: [["k", "i"]], value: 2 ** 53 },
      { op: "add", name: "omni_cost_usd_total", labels: [["k", "i"]], value: 1 },
      { op: "set", name: "omni_breaker_open", labels: [["provider", "x"]], value: 1.5 },
      { op: "set", name: "omni_breaker_open", labels: [["provider", "x"]], value: -3 },
    ],
  },
  {
    name: "histogram-boundaries",
    maxSeries: 5000,
    ops: [
      ...[
        0,
        0.005,
        0.0051,
        0.01,
        0.025,
        0.05,
        0.1,
        0.25,
        0.5,
        1,
        2.5,
        5,
        10,
        30,
        60,
        60.001,
        1000,
        -1,
        "NaN",
        "Infinity",
        "-0",
      ].map(
        (value): Op => ({
          op: "observe",
          name: "omni_upstream_duration_seconds",
          labels: [["provider", "custom"]],
          value,
        }),
      ),
      {
        op: "observe",
        name: "omni_ttft_seconds",
        labels: [
          ["provider", "custom"],
          ["model", "m"],
        ],
        value: 0.003,
      },
      {
        op: "observe",
        name: "omni_ttft_seconds",
        labels: [
          ["provider", "custom"],
          ["model", "m"],
        ],
        value: 0.004,
      },
    ],
  },
  {
    name: "histogram-sum-only-nan",
    maxSeries: 5000,
    ops: [
      {
        op: "observe",
        name: "omni_request_duration_seconds",
        labels: [
          ["provider", "p"],
          ["model", "m"],
        ],
        value: "NaN",
      },
    ],
  },
  {
    name: "mixed-ops-on-one-series",
    maxSeries: 5000,
    ops: [
      { op: "observe", name: "omni_ttft_seconds", labels: [["a", "1"]], value: 0.5 },
      { op: "add", name: "omni_ttft_seconds", labels: [["a", "1"]], value: 1 },
      { op: "set", name: "omni_ttft_seconds", labels: [["a", "1"]], value: 7 },
      { op: "observe", name: "omni_ttft_seconds", labels: [["a", "1"]], value: 0.01 },
      { op: "set", name: "omni_requests_total", labels: [["a", "1"]], value: 4 },
      { op: "observe", name: "omni_requests_total", labels: [["a", "1"]], value: 0.01 },
    ],
  },
  {
    name: "cap-folds-api-keys",
    maxSeries: 6,
    ops: [
      { op: "set", name: "omni_build_info", labels: [["version", "v"]], value: 1 },
      ...completion("k1", "ok"),
      ...completion("k2", "ok"),
      ...completion("k1", "ok"),
      ...completion("k3", "other-model"),
      {
        op: "add",
        name: "omni_ratelimit_rejected_total",
        labels: [
          ["dimension", "tokens"],
          ["window", "5h"],
        ],
      },
      ...completion("k1", "ok"),
      ...completion("k4", "ok"),
    ],
  },
  {
    name: "cap-one",
    maxSeries: 1,
    ops: [
      { op: "add", name: "omni_requests_total", labels: [["api_key_id", "a"]] },
      { op: "add", name: "omni_requests_total", labels: [["api_key_id", "b"]] },
      { op: "add", name: "omni_requests_total", labels: [["api_key_id", "other"]] },
      { op: "add", name: "omni_requests_total", labels: [["api_key_id", "b"]] },
      { op: "add", name: "omni_requests_total", labels: [["api_key_id", "a"]], value: 5 },
      {
        op: "add",
        name: "omni_requests_total",
        labels: [
          ["api_key_id", "c"],
          ["x", "y"],
        ],
      },
      { op: "set", name: "omni_coord_fallback", labels: [], value: 1 },
      { op: "add", name: "omni_requests_total", labels: [["api_key_id", "d"]] },
    ],
  },
  {
    name: "cap-other-key-collides",
    maxSeries: 2,
    ops: [
      {
        op: "add",
        name: "omni_cost_usd_total",
        labels: [
          ["model", "m"],
          ["api_key_id", "a"],
        ],
        value: 0.5,
      },
      {
        op: "add",
        name: "omni_cost_usd_total",
        labels: [
          ["model", "m"],
          ["api_key_id", "other"],
        ],
        value: 0.25,
      },
      {
        op: "add",
        name: "omni_cost_usd_total",
        labels: [
          ["model", "m"],
          ["api_key_id", "z"],
        ],
        value: 0.125,
      },
      {
        op: "add",
        name: "omni_cost_usd_total",
        labels: [
          ["api_key_id", "y"],
          ["model", "m"],
        ],
        value: 1,
      },
    ],
  },
];

const out = cases.map((c) => ({ ...c, rendered: run(c.maxSeries, c.ops) }));
// Formatted by the repository's pinned Biome, so `biome check` accepts the
// committed file unchanged and a rerun reproduces it byte for byte.
const formatted = Bun.spawnSync(
  ["bunx", "biome", "format", "--stdin-file-path=conformance/vectors/metrics.json"],
  {
    cwd: new URL("../..", import.meta.url).pathname,
    stdin: new TextEncoder().encode(`${JSON.stringify({ cases: out })}\n`),
    stdout: "pipe",
    stderr: "pipe",
  },
);
if (formatted.exitCode !== 0) throw new Error(formatted.stderr.toString());
process.stdout.write(formatted.stdout.toString());
