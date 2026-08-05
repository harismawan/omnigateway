import type { QuotaWindow } from "@/api/types.ts";

const labels: Readonly<Record<QuotaWindow["windowType"], string>> = {
  fiveHour: "five hour quota",
  daily: "daily quota",
  weekly: "weekly quota",
};

export function QuotaBar({ window }: { window: QuotaWindow }) {
  if (window.limit === null) return null;
  const percent = Math.min(100, Math.round((window.used / window.limit) * 100));
  const tone = percent >= 90 ? "bg-bad" : percent >= 70 ? "bg-warn" : "bg-ok";

  return (
    <div className="space-y-1 text-xs">
      <div className="flex justify-between text-muted-foreground">
        <span>{labels[window.windowType]}</span>
        <span>{percent}% used</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-muted">
        <div className={`h-full ${tone}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
