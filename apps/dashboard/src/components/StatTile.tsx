import { cn } from "@/lib/utils.ts";

const tones = {
  default: "border-border bg-card",
  ok: "border-ok/30 bg-ok/10",
  warn: "border-warn/30 bg-warn/10",
  bad: "border-bad/30 bg-bad/10",
  info: "border-info/30 bg-info/10",
} as const;

type StatTone = keyof typeof tones;

export function StatTile({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: StatTone;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: Metric labels are not form controls.
    <div aria-label={label} className={cn("rounded-lg border p-4", tones[tone])} role="group">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {detail !== undefined && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}
