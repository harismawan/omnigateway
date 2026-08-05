import type { CredentialHealth } from "@/api/types.ts";
import { StatusBadge } from "@/components/StatusBadge.tsx";
import { formatMs, formatRelative } from "@/lib/format.ts";

export type HealthSummary = {
  label: "healthy" | "rate limited" | "breaker open" | "unused";
  tone: "ok" | "warn" | "bad" | "muted";
  detail: string | null;
};

export function summarizeHealth(rows: CredentialHealth[], now: number): HealthSummary {
  if (rows.length === 0) return { label: "unused", tone: "muted", detail: null };

  const open = rows.find((row) => row.breakerState === "open");
  if (open !== undefined) {
    return {
      label: "breaker open",
      tone: "bad",
      detail: `${open.model}, ${open.consecutiveFailures} consecutive failures`,
    };
  }

  const limited = rows.find((row) => row.rateLimitedUntil !== null && row.rateLimitedUntil > now);
  if (limited !== undefined) {
    return {
      label: "rate limited",
      tone: "warn",
      detail: `${limited.model}, clears ${formatRelative(limited.rateLimitedUntil ?? now, now)}`,
    };
  }

  const latencies = rows.flatMap((row) => (row.ewmaTtftMs === null ? [] : [row.ewmaTtftMs]));
  const meanLatency =
    latencies.length === 0
      ? null
      : latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length;
  return {
    label: "healthy",
    tone: "ok",
    detail: meanLatency === null ? null : `TTFT ${formatMs(meanLatency)}`,
  };
}

export function HealthPill({ health, now }: { health: CredentialHealth[]; now: number }) {
  const summary = summarizeHealth(health, now);
  return (
    <div className="flex items-center gap-2">
      <StatusBadge label={summary.label} tone={summary.tone} />
      {summary.detail !== null && (
        <span className="text-xs text-muted-foreground">{summary.detail}</span>
      )}
    </div>
  );
}
