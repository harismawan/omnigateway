import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { logsQuery } from "@/api/queries.ts";
import { DataTableFrame } from "@/components/DataTableFrame.tsx";
import { ErrorState } from "@/components/ErrorState.tsx";
import { PageHeader } from "@/components/PageHeader.tsx";
import { StatusBadge } from "@/components/StatusBadge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Label } from "@/components/ui/label.tsx";
import { LogRow } from "@/features/logs/LogRow.tsx";

/** The core plan has no WebSocket; three seconds is the live tail. */
export const POLL_MS = 3_000;
export const LOG_LIMITS: readonly number[] = [100, 200, 500];

export function LogsScreen({ now, pollMs = POLL_MS }: { now: number; pollMs?: number }) {
  const [limit, setLimit] = useState(100);
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const logs = useQuery({
    ...logsQuery(limit, pollMs),
    refetchInterval: paused ? false : pollMs,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        actions={null}
        description="Inspect recent gateway requests and resolve failures."
        eyebrow="Operations"
        title="Live request logs"
      />
      <div className="sticky top-0 z-10 flex flex-wrap items-end justify-between gap-4 border-y bg-background/95 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <StatusBadge label={paused ? "Paused" : "Live"} tone={paused ? "muted" : "ok"} />
          <p className="text-xs text-muted-foreground">
            {paused ? "Polling stopped." : `Refreshing every ${pollMs / 1_000}s.`}
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="log-limit">Rows</Label>
            <select
              className="h-9 rounded-md border bg-transparent px-2 text-sm"
              id="log-limit"
              onChange={(event) => setLimit(Number(event.target.value))}
              value={String(limit)}
            >
              {LOG_LIMITS.map((rows) => (
                <option key={rows} value={String(rows)}>
                  {rows}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={() => setPaused((value) => !value)} size="sm" variant="outline">
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </div>

      {logs.isError ? <ErrorState error={logs.error} onRetry={() => logs.refetch()} /> : null}
      {logs.isPending ? <p className="text-sm opacity-70">Loading logs…</p> : null}
      {logs.data !== undefined ? (
        logs.data.length === 0 ? (
          <p className="text-sm opacity-70">No requests yet.</p>
        ) : (
          <DataTableFrame ariaLabel="Request logs">
            <table aria-label="Request logs" className="w-full min-w-[760px] text-sm">
              <thead className="sticky top-0 z-[1] bg-card text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Requested</th>
                  <th className="px-3 py-2">Served</th>
                  <th className="px-3 py-2">Provider</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Error</th>
                  <th className="px-3 py-2 text-right">Duration</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {logs.data.map((log) => (
                  <LogRow
                    expanded={expanded === log.id}
                    key={log.id}
                    log={log}
                    now={now}
                    onToggle={() => setExpanded((value) => (value === log.id ? null : log.id))}
                  />
                ))}
              </tbody>
            </table>
          </DataTableFrame>
        )
      ) : null}
    </div>
  );
}

export const Route = createFileRoute("/_app/logs")({
  component: () => <LogsScreen now={Date.now()} />,
});
