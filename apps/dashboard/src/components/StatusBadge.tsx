import { Circle, CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils.ts";

export type StatusTone = "ok" | "warn" | "bad" | "info" | "muted";

const tones: Readonly<Record<StatusTone, string>> = {
  ok: "border-ok/30 bg-ok/10 text-ok",
  warn: "border-warn/30 bg-warn/10 text-warn",
  bad: "border-bad/30 bg-bad/10 text-bad",
  info: "border-info/30 bg-info/10 text-info",
  muted: "border-border bg-muted text-muted-foreground",
};

const icons: Readonly<Record<StatusTone, typeof Circle>> = {
  ok: CircleCheck,
  warn: TriangleAlert,
  bad: CircleX,
  info: Info,
  muted: Circle,
};

export function StatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  const Icon = icons[tone];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        tones[tone],
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {label}
    </span>
  );
}
