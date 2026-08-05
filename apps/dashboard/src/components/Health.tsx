import type { CredentialHealth } from "@/api/types.ts";
import { Badge } from "@/components/ui/badge.tsx";
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

  const latency = rows.find((row) => row.ewmaTtftMs !== null)?.ewmaTtftMs ?? null;
  return {
    label: "healthy",
    tone: "ok",
    detail: latency === null ? null : `TTFT ${formatMs(latency)}`,
  };
}

const tones: Record<HealthSummary["tone"], string> = {
  ok: "bg-ok/15 text-ok border-ok/30",
  warn: "bg-warn/15 text-warn border-warn/30",
  bad: "bg-bad/15 text-bad border-bad/30",
  muted: "bg-muted text-muted-foreground border-border",
};

export function HealthPill({ health, now }: { health: CredentialHealth[]; now: number }) {
  const summary = summarizeHealth(health, now);
  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className={tones[summary.tone]}>
        {summary.label}
      </Badge>
      {summary.detail !== null && (
        <span className="text-xs text-muted-foreground">{summary.detail}</span>
      )}
    </div>
  );
}
