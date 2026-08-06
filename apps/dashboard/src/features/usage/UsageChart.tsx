import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { UsageBucket } from "@/api/types.ts";
import { formatTokens, formatUsd } from "@/lib/format.ts";

export type UsageMetric = "requests" | "tokens" | "cost" | "errors";

const METRIC_LABELS: Record<UsageMetric, string> = {
  requests: "Requests",
  tokens: "Tokens",
  cost: "Estimated cost",
  errors: "Errors",
};

function valueFor(row: UsageBucket, metric: UsageMetric): number {
  switch (metric) {
    case "requests":
      return row.requests;
    case "tokens":
      return row.inputTokens + row.outputTokens;
    case "cost":
      return row.costUsd;
    case "errors":
      return row.errors;
  }
}

export function chartRows(rows: readonly UsageBucket[], metric: UsageMetric) {
  return rows.map((row) => ({ key: row.key, value: valueFor(row, metric) }));
}

function formatValue(value: number, metric: UsageMetric): string {
  if (metric === "cost") return formatUsd(value);
  if (metric === "tokens") return formatTokens(value);
  return value.toLocaleString();
}

function formatTooltipValue(value: number, metric: UsageMetric): string {
  if (metric === "cost") return formatUsd(value);
  return value.toLocaleString();
}

export function UsageChart({
  rows,
  metric,
  height = 280,
}: {
  rows: readonly UsageBucket[];
  metric: UsageMetric;
  height?: number;
}) {
  const data = chartRows(rows, metric);
  const label = METRIC_LABELS[metric];
  return (
    <section
      aria-label={`${label} chart`}
      className="rounded-lg border bg-card p-4"
      style={{ height: height + 32 }}
    >
      <ResponsiveContainer height={height} width="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
          <XAxis dataKey="key" tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} />
          <YAxis
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
            tickFormatter={(value: number) => formatValue(value, metric)}
            width={64}
          />
          <Tooltip
            contentStyle={{ background: "var(--chart-tooltip)", border: "1px solid var(--border)" }}
            formatter={(value) => formatTooltipValue(typeof value === "number" ? value : 0, metric)}
            labelFormatter={(value) => (typeof value === "string" ? value : "")}
          />
          <Bar dataKey="value" fill="var(--chart-1)" name={label} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </section>
  );
}
