import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { logsQuery, usageQuery } from "@/api/queries.ts";
import { USAGE_GROUP_BY, type UsageBucket, type UsageGroupBy } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { StatCards, totals } from "@/features/usage/StatCards.tsx";
import { UsageChart, type UsageMetric } from "@/features/usage/UsageChart.tsx";
import { formatTokens, formatUsd } from "@/lib/format.ts";

export { totals };

export type UsageRange = { id: string; label: string; ms: number };
export const RANGES: readonly UsageRange[] = [
  { id: "24h", label: "Last 24 hours", ms: 86_400_000 },
  { id: "7d", label: "Last 7 days", ms: 7 * 86_400_000 },
  { id: "30d", label: "Last 30 days", ms: 30 * 86_400_000 },
];

function formatRate(part: number, whole: number): string {
  return whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`;
}

function sortByCost(rows: readonly UsageBucket[]): UsageBucket[] {
  return [...rows].sort((a, b) => b.costUsd - a.costUsd);
}

export function UsageScreen({ now }: { now: number }) {
  const [rangeId, setRangeId] = useState(RANGES[0]?.id ?? "24h");
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("model");
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const range = RANGES.find((candidate) => candidate.id === rangeId) ?? RANGES[0];
  const sinceMs = now - (range?.ms ?? 86_400_000);
  const usage = useQuery(usageQuery(groupBy, sinceMs));
  const logs = useQuery(logsQuery(200, 30_000));
  const rows = sortByCost(usage.data ?? []);
  const rateLimited = (logs.data ?? []).filter((log) => log.errorCode === "RATE_LIMIT").length;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
        <p className="text-sm text-muted-foreground">
          Requests, tokens, costs, and errors by gateway dimension.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="grid gap-1 text-sm">
          <span>Range</span>
          <select
            value={rangeId}
            onChange={(event) => setRangeId(event.target.value)}
            className="rounded-md border bg-background px-3 py-2"
          >
            {RANGES.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span>Group by</span>
          <select
            value={groupBy}
            onChange={(event) => setGroupBy(event.target.value as UsageGroupBy)}
            className="rounded-md border bg-background px-3 py-2"
          >
            {USAGE_GROUP_BY.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span>Chart metric</span>
          <select
            value={metric}
            onChange={(event) => setMetric(event.target.value as UsageMetric)}
            className="rounded-md border bg-background px-3 py-2"
          >
            <option value="cost">Cost</option>
            <option value="requests">Requests</option>
            <option value="tokens">Tokens</option>
          </select>
        </label>
      </div>
      {usage.isError ? <ErrorState error={usage.error} onRetry={() => usage.refetch()} /> : null}
      {usage.isLoading ? <p className="text-sm text-muted-foreground">Loading usage…</p> : null}
      {usage.data === undefined ? null : (
        <>
          <StatCards
            rows={rows}
            rateLimited={rateLimited}
            logSampleSize={(logs.data ?? []).length}
          />
          <UsageChart rows={rows} metric={metric} />
          <section aria-label="Usage table" className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-180 text-sm">
              <caption className="sr-only">Usage buckets sorted by cost, highest first</caption>
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="p-3">{groupBy}</th>
                  <th className="p-3 text-right">Requests</th>
                  <th className="p-3 text-right">Input tokens</th>
                  <th className="p-3 text-right">Output tokens</th>
                  <th className="p-3 text-right">Cost</th>
                  <th className="p-3 text-right">Errors</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-b last:border-0">
                    <td className="p-3 font-medium">{row.key}</td>
                    <td className="p-3 text-right tabular-nums">{row.requests.toLocaleString()}</td>
                    <td className="p-3 text-right tabular-nums">{formatTokens(row.inputTokens)}</td>
                    <td className="p-3 text-right tabular-nums">
                      {formatTokens(row.outputTokens)}
                    </td>
                    <td className="p-3 text-right tabular-nums">{formatUsd(row.costUsd)}</td>
                    <td className="p-3 text-right tabular-nums">
                      {row.errors === 0 ? "0" : formatRate(row.errors, row.requests)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t font-medium">
                <tr>
                  <td className="p-3">Total</td>
                  <td className="p-3 text-right tabular-nums">
                    {totals(rows).requests.toLocaleString()}
                  </td>
                  <td colSpan={2} />
                  <td className="p-3 text-right tabular-nums">{formatUsd(totals(rows).costUsd)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

export const Route = createFileRoute("/_app/usage")({
  component: () => <UsageScreen now={Date.now()} />,
});
