import type { RequestLog } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { formatMs, formatRelative, formatTokens, formatUsd } from "@/lib/format.ts";

function statusClass(status: number): string {
  if (status >= 500) return "text-bad";
  if (status >= 400) return "text-warn";
  return "text-good";
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs opacity-60">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function LogRow({
  log,
  now,
  expanded,
  onToggle,
}: {
  log: RequestLog;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr>
        <td className="py-2 pr-3 text-xs opacity-70">{formatRelative(log.at, now)}</td>
        <td className="pr-3 font-mono text-xs">{log.requestedModel}</td>
        <td className="pr-3 font-mono text-xs">{log.resolvedModel ?? "—"}</td>
        <td className="pr-3">{log.resolvedProvider ?? "—"}</td>
        <td className={statusClass(log.status)}>{log.status}</td>
        <td className="text-warn">{log.errorCode ?? ""}</td>
        <td className="text-right tabular-nums">{formatMs(log.durationMs)}</td>
        <td className="text-right tabular-nums">{formatUsd(log.costUsd)}</td>
        <td className="pl-3 text-right">
          <Button
            aria-expanded={expanded}
            aria-label={`Details for ${log.id}`}
            onClick={onToggle}
            size="sm"
            variant="ghost"
          >
            Details
          </Button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td className="bg-muted/30 p-3" colSpan={9}>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <Detail label="Request" value={log.id} />
              <Detail label="API key" value={log.apiKeyId ?? "—"} />
              <Detail label="Credential" value={log.credentialId ?? "—"} />
              <Detail label="Attempts" value={String(log.attempts)} />
              <Detail
                label="Tokens"
                value={`${formatTokens(log.inputTokens)} in · ${formatTokens(log.outputTokens)} out`}
              />
              <Detail
                label="Cache"
                value={`${formatTokens(log.cacheReadTokens)} read · ${formatTokens(log.cacheWriteTokens)} write`}
              />
              <Detail label="Time to first token" value={formatMs(log.ttftMs)} />
              <Detail label="Duration" value={formatMs(log.durationMs)} />
              <Detail label="Cost" value={formatUsd(log.costUsd)} />
            </dl>
            {log.degradations.length > 0 ? (
              <p className="mt-3 text-sm">Degradations: {log.degradations.join(", ")}</p>
            ) : null}
            {log.attempts > 1 ? (
              <p className="mt-3 text-sm opacity-70">
                This request took {log.attempts} attempts. Earlier attempts are not retained.
              </p>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
