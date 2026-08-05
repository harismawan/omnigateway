import type { UsageBucket } from "@/api/types.ts";
import { StatTile } from "@/components/StatTile.tsx";
import { formatTokens, formatUsd } from "@/lib/format.ts";

export type UsageTotals = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  errors: number;
};

export function totals(rows: readonly UsageBucket[]): UsageTotals {
  return rows.reduce<UsageTotals>(
    (total, row) => ({
      requests: total.requests + row.requests,
      inputTokens: total.inputTokens + row.inputTokens,
      outputTokens: total.outputTokens + row.outputTokens,
      costUsd: total.costUsd + row.costUsd,
      errors: total.errors + row.errors,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, errors: 0 },
  );
}

function formatRate(part: number, whole: number): string {
  return whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`;
}

export function StatCards({ rows }: { rows: readonly UsageBucket[] }) {
  const total = totals(rows);
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile label="Requests" value={total.requests.toLocaleString()} />
      <StatTile label="Tokens" value={formatTokens(total.inputTokens + total.outputTokens)} />
      <StatTile label="Estimated cost" value={formatUsd(total.costUsd)} />
      <StatTile label="Error rate" value={formatRate(total.errors, total.requests)} />
    </div>
  );
}
