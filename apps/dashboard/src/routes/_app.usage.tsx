import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { logsQuery, usageQuery } from "@/api/queries.ts";
import { USAGE_GROUP_BY, type UsageBucket, type UsageGroupBy } from "@/api/types.ts";
import { DataTableFrame } from "@/components/DataTableFrame.tsx";
import { ErrorState } from "@/components/ErrorState.tsx";
import { PageHeader } from "@/components/PageHeader.tsx";
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
      <PageHeader
        actions={null}
        description="Requests, tokens, costs, and errors by gateway dimension."
        title="Usage"
      />
      {logs.data !== undefined && logs.data.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          Rate limited: {formatRate(rateLimited, logs.data.length)} from last {logs.data.length}{" "}
          requests.
        </p>
      ) : null}
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
        <fieldset className="grid gap-1 text-sm">
          <legend>Group by</legend>
          <div className="flex flex-wrap gap-3">
            {USAGE_GROUP_BY.map((candidate) => {
              const id = `usage-group-by-${candidate}`;
              return (
                <label className="flex items-center gap-2" htmlFor={id} key={candidate}>
                  <input
                    checked={groupBy === candidate}
                    id={id}
                    name="usage-group-by"
                    onChange={() => setGroupBy(candidate)}
                    type="radio"
                    value={candidate}
                  />
                  {candidate === "apiKey"
                    ? "API key"
                    : candidate.slice(0, 1).toUpperCase() + candidate.slice(1)}
                </label>
              );
            })}
          </div>
        </fieldset>
        <fieldset className="grid gap-1 text-sm">
          <legend>Chart metric</legend>
          <div className="flex flex-wrap gap-3">
            {(
              [
                ["cost", "Estimated cost"],
                ["requests", "Requests"],
                ["tokens", "Tokens"],
                ["errors", "Errors"],
              ] as const
            ).map(([value, label]) => {
              const id = `usage-chart-metric-${value}`;
              return (
                <label className="flex items-center gap-2" htmlFor={id} key={value}>
                  <input
                    checked={metric === value}
                    id={id}
                    name="usage-chart-metric"
                    onChange={() => setMetric(value)}
                    type="radio"
                    value={value}
                  />
                  {label}
                </label>
              );
            })}
          </div>
        </fieldset>
      </div>
      {usage.isError ? <ErrorState error={usage.error} onRetry={() => usage.refetch()} /> : null}
      {usage.isLoading ? <p className="text-sm text-muted-foreground">Loading usage…</p> : null}
      {usage.data === undefined ? null : (
        <>
          <StatCards rows={rows} />
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests in this window.</p>
          ) : (
            <>
              <UsageChart rows={rows} metric={metric} />
              <DataTableFrame ariaLabel="Usage breakdown">
                <table aria-label="Usage breakdown" className="w-full min-w-180 text-sm">
                  <caption className="sr-only">Usage breakdown</caption>
                  <thead className="sticky top-0 border-b bg-muted/40 text-left">
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
                        <td className="p-3 font-mono font-medium">{row.key}</td>
                        <td className="p-3 text-right tabular-nums">
                          {row.requests.toLocaleString()}
                        </td>
                        <td className="p-3 text-right tabular-nums">
                          {formatTokens(row.inputTokens)}
                        </td>
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
                      <td className="p-3 text-right tabular-nums">
                        {formatUsd(totals(rows).costUsd)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </DataTableFrame>
            </>
          )}
        </>
      )}
    </div>
  );
}

export const Route = createFileRoute("/_app/usage")({
  component: () => <UsageScreen now={Date.now()} />,
});
