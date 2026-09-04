import { HISTOGRAM_BUCKETS, type MetricLabels, type MetricSnapshot } from "./registry.ts";

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labels(labels: MetricLabels, extra?: readonly [string, string]): string {
  const entries = Object.entries(labels);
  if (extra !== undefined) entries.push([extra[0], extra[1]]);
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

function number(value: number): string {
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  if (Number.isNaN(value)) return "NaN";
  return String(value);
}

export function renderPrometheus(snapshot: MetricSnapshot): string {
  const out: string[] = [];
  for (const metric of snapshot.metrics) {
    out.push(`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`);
    for (const sample of metric.samples) {
      if (metric.type !== "histogram" || !("buckets" in sample)) {
        out.push(`${metric.name}${labels(sample.labels)} ${number(sample.value)}`);
        continue;
      }
      for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
        out.push(
          `${metric.name}_bucket${labels(sample.labels, ["le", String(HISTOGRAM_BUCKETS[i])])} ${number(sample.buckets[i] ?? 0)}`,
        );
      }
      out.push(
        `${metric.name}_bucket${labels(sample.labels, ["le", "+Inf"])} ${sample.count}`,
        `${metric.name}_sum${labels(sample.labels)} ${number(sample.sum)}`,
        `${metric.name}_count${labels(sample.labels)} ${sample.count}`,
      );
    }
  }
  return `${out.join("\n")}\n`;
}
