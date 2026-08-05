import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import type { UsageBucket } from "@/api/types.ts";
import { formatTokens, formatUsd } from "@/lib/format.ts";

export type UsageMetric = "requests" | "tokens" | "cost";

const METRIC_LABELS: Record<UsageMetric, string> = {
  requests: "Requests",
  tokens: "Tokens",
  cost: "Cost",
};

function valueFor(row: UsageBucket, metric: UsageMetric): number {
  switch (metric) {
    case "requests":
      return row.requests;
    case "tokens":
      return row.inputTokens + row.outputTokens;
    case "cost":
      return row.costUsd;
  }
}

function formatValue(value: number, metric: UsageMetric): string {
  if (metric === "cost") return formatUsd(value);
  if (metric === "tokens") return formatTokens(value);
  return value.toLocaleString();
}

export function UsageChart({
  rows,
  metric,
  width = 720,
  height = 280,
}: {
  rows: readonly UsageBucket[];
  metric: UsageMetric;
  width?: number;
  height?: number;
}) {
  const data = rows.map((row) => ({ key: row.key, value: valueFor(row, metric) }));
  const label = METRIC_LABELS[metric];
  return (
    <section aria-label={`${label} chart`} className="overflow-x-auto rounded-lg border p-4">
      <BarChart
        width={width}
        height={height}
        data={data}
        margin={{ top: 8, right: 12, bottom: 8, left: 8 }}
      >
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="key" tick={{ fontSize: 12 }} />
        <YAxis
          tickFormatter={(value: number) => formatValue(value, metric)}
          tick={{ fontSize: 12 }}
          width={64}
        />
        <Tooltip
          formatter={(value) => formatValue(typeof value === "number" ? value : 0, metric)}
          labelFormatter={(label) => (typeof label === "string" ? label : "")}
        />
        <Bar dataKey="value" name={label} fill="var(--chart-1, #2563eb)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </section>
  );
}
