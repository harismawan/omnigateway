import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { logsQuery } from "@/api/queries.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Logs</h1>
          <p className="text-xs opacity-60">
            {paused ? "Paused." : `Refreshing every ${POLL_MS / 1_000}s.`}
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs opacity-60">
                <tr>
                  <th className="py-1">When</th>
                  <th>Requested</th>
                  <th>Served</th>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Error</th>
                  <th className="text-right">Duration</th>
                  <th className="text-right">Cost</th>
                  <th />
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
          </div>
        )
      ) : null}
    </div>
  );
}

export const Route = createFileRoute("/_app/logs")({
  component: () => <LogsScreen now={Date.now()} />,
});
