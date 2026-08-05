import type { UsageBucket } from "@/api/types.ts";
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

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <fieldset aria-label={label} className="rounded-lg border p-4">
      <legend className="text-sm text-muted-foreground">{label}</legend>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {detail === undefined ? null : <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
    </fieldset>
  );
}

export function StatCards({
  rows,
  rateLimited,
  logSampleSize,
}: {
  rows: readonly UsageBucket[];
  rateLimited: number;
  logSampleSize: number;
}) {
  const total = totals(rows);
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Stat label="Requests" value={total.requests.toLocaleString()} />
      <Stat label="Tokens" value={formatTokens(total.inputTokens + total.outputTokens)} />
      <Stat label="Cost" value={formatUsd(total.costUsd)} />
      <Stat label="Error rate" value={formatRate(total.errors, total.requests)} />
      <Stat
        label="Rate limited"
        value={formatRate(rateLimited, logSampleSize)}
        detail="last 200 requests"
      />
    </div>
  );
}
