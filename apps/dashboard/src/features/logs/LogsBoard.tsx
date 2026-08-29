import { useMemo, useState } from "react";
import styled from "styled-components";
import {
  LOG_CADENCE_MS,
  useBodyLoggingActive,
  useCredentials,
  useKeys,
  useLogs,
} from "../../api/queries.ts";
import type { RequestRow } from "../../api/types.ts";
import { PageHead } from "../../components/Rack.tsx";
import { formatCount } from "../../lib/format.ts";
import { isError, isPending } from "../../lib/vitals.ts";
import { useLive } from "../../session/live.tsx";
import { Button } from "../../ui/Button.tsx";
import { Input, Select } from "../../ui/Field.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Row, ScrollX } from "../../ui/primitives.ts";
import { Empty, Failure, SkeletonRows } from "../../ui/States.tsx";
import { BodyArtifact } from "./BodyArtifact.tsx";
import { filterLogs, RequestDetail, RequestTable, useCurrentTime } from "./RequestTable.tsx";

const LIMITS = [50, 100, 250, 500] as const;

type Filter = "all" | "failed";

const Controls = styled(Row)`
  gap: ${({ theme }) => theme.space(2)};
  flex-wrap: wrap;
`;

const Search = styled(Input)`
  width: 220px;
`;

const Narrow = styled(Select)`
  width: auto;
`;

const RequestLogModule = styled(Module)`
  flex: 1;
  min-height: 0;

  > div {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
`;

const RequestLogScroller = styled(ScrollX)`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
`;

/**
 * One row per request, most recent first.
 *
 * Fed by `res:logs` when the socket is up and by the two-second interval when it
 * is not — the same fetch either way, chosen per render by `cadence`.
 */
export function LogsBoard() {
  const { cadence, live: liveUpdates } = useLive();
  const [limit, setLimit] = useState<number>(100);
  const [filter, setFilter] = useState<Filter>("all");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState<RequestRow | null>(null);

  const logs = useLogs(limit, cadence(LOG_CADENCE_MS, "res:logs"));
  const credentials = useCredentials();
  const keys = useKeys();
  // Both keys, not just the setting: an installation whose environment never
  // permitted capture records nothing however the setting reads, and telling an
  // operator their prompts are being kept when they are not is the worse lie of
  // the two. Unknown — the settings read failed — is reported as not recording.
  const capturing = useBodyLoggingActive();
  const hasPending = (logs.data ?? []).some(isPending);
  const now = useCurrentTime(liveUpdates && hasPending);

  /**
   * The labels a row is annotated with.
   *
   * A row outlives the key and the account that made it — a revoked key still
   * has requests in the log — so a missing label falls back to the id rather
   * than to nothing.
   */
  const names = useMemo(
    () => ({
      accounts: new Map((credentials.data ?? []).map((row) => [row.id, row.label])),
      keys: new Map((keys.data ?? []).map((key) => [key.id, key.label])),
    }),
    [credentials.data, keys.data],
  );

  const rows = filterLogs(logs.data ?? [], filter, term, names);

  const failed = (logs.data ?? []).filter(isError).length;
  const live = (logs.data ?? []).filter(isPending).length;

  return (
    <>
      <PageHead
        legend="Logs"
        title="Recent requests"
        summary={
          logs.isLoading
            ? "Reading the request log…"
            : `${formatCount(logs.data?.length ?? 0)} recent requests, ${formatCount(failed)} of them failed${live === 0 ? "" : `, ${formatCount(live)} still running`}. ${capturing.data === true ? "Body capture is on: open a request to read what it sent and received." : "Prompt and response bodies are not being recorded."}`
        }
        actions={
          <Controls>
            <Search
              value={term}
              placeholder="Filter by model, account, key, or error"
              aria-label="Filter requests"
              onChange={(event) => setTerm(event.target.value)}
            />
            <Narrow
              value={filter}
              aria-label="Show which requests"
              onChange={(event) => setFilter(event.target.value as Filter)}
            >
              <option value="all">All requests</option>
              <option value="failed">Failed only</option>
            </Narrow>
            <Narrow
              value={limit}
              aria-label="How many requests to fetch"
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {LIMITS.map((value) => (
                <option key={value} value={value}>
                  last {value}
                </option>
              ))}
            </Narrow>
          </Controls>
        }
      />

      <RequestLogModule legend="Request log" meta={`${rows.length} shown`} flush>
        {logs.isError ? (
          <Failure error={logs.error} onRetry={() => void logs.refetch()} />
        ) : logs.isLoading ? (
          <div style={{ padding: 12 }}>
            <SkeletonRows rows={8} />
          </div>
        ) : rows.length === 0 ? (
          <Empty
            legend="Nothing to show"
            message={
              (logs.data?.length ?? 0) === 0
                ? "No requests have reached the gateway yet."
                : "No request in this window matches the filter. Clear it to see everything."
            }
          />
        ) : (
          <RequestLogScroller data-testid="request-log-scroller">
            <RequestTable rows={rows} now={now} names={names} onOpen={setOpen} />
          </RequestLogScroller>
        )}
      </RequestLogModule>

      <Modal
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        title="Request detail"
        // Wider than the metadata alone needs: the captured bodies below are
        // JSON, and a payload wrapped every forty columns is unreadable.
        width="760px"
        footer={
          <Button type="button" onClick={() => setOpen(null)}>
            Close
          </Button>
        }
      >
        {open === null ? null : (
          <RequestDetail log={open} names={names}>
            {/* Mounted with the row, so the artifact is fetched only while
                someone is looking at it. It reports its own absence, so there
                is nothing to guard on here. */}
            <BodyArtifact requestId={open.id} />
          </RequestDetail>
        )}
      </Modal>
    </>
  );
}
