import { useMemo, useState } from "react";
import styled from "styled-components";
import {
  isHeadPage,
  LOG_CADENCE_MS,
  queryKeys,
  useBodyLoggingActive,
  useCredentials,
  useKeys,
  useLogPages,
  useTrimToHead,
} from "../../api/queries.ts";
import { type LogFilters, NO_LOG_FILTERS, type RequestRow } from "../../api/types.ts";
import { PageHead } from "../../components/Rack.tsx";
import { formatCount } from "../../lib/format.ts";
import { isError, isPending } from "../../lib/vitals.ts";
import { useLive } from "../../session/live.tsx";
import { Button } from "../../ui/Button.tsx";
import { Select } from "../../ui/Field.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Muted, Row, ScrollX } from "../../ui/primitives.ts";
import { Empty, Failure, SkeletonRows } from "../../ui/States.tsx";
import { BodyArtifact } from "./BodyArtifact.tsx";
import { LogFilterBar } from "./LogFilterBar.tsx";
import { RequestDetail, RequestTable, useCurrentTime } from "./RequestTable.tsx";

/** Rows per request, not rows in total: "Load older" appends another page. */
const LIMITS = [50, 100, 250, 500] as const;

const Controls = styled(Row)`
  gap: ${({ theme }) => theme.space(2)};
  flex-wrap: wrap;
`;

const Narrow = styled(Select)`
  width: auto;
`;

const More = styled(Row)`
  justify-content: center;
  gap: ${({ theme }) => theme.space(2)};
  padding: ${({ theme }) => theme.space(3)};
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
 * is not — the same fetch either way, chosen per render by `cadence`. Both stop
 * once the operator has loaded a second page: the topic and the poll are about
 * the head of the log, and a board reading older pages is not at the head.
 *
 * Every filter is a request parameter, matched exactly by the gateway before the
 * page limit is applied — so "failed requests by this key last Tuesday" means
 * that, and not "whichever of the newest hundred rows happen to match".
 */
export function LogsBoard() {
  const { cadence, live: liveUpdates } = useLive();
  const [limit, setLimit] = useState<number>(100);
  const [filters, setFilters] = useState<LogFilters>(NO_LOG_FILTERS);
  const [open, setOpen] = useState<RequestRow | null>(null);

  // Changing any filter changes the query key, so pagination resets to the
  // first page without this board holding a cursor of its own.
  const logs = useLogPages(filters, limit, cadence(LOG_CADENCE_MS, "res:logs"));
  const rows = useMemo(
    () => (logs.data?.pages ?? []).flatMap((page) => page.logs),
    [logs.data?.pages],
  );
  // Loading scrollback stops the poll and the push, so the board says so and
  // offers the way back rather than leaving a frozen head to be read as a quiet
  // gateway.
  const paused = !isHeadPage(logs.data);
  const backToHead = useTrimToHead(queryKeys.logPages(filters, limit));
  const credentials = useCredentials();
  const keys = useKeys();
  // Both keys, not just the setting: an installation whose environment never
  // permitted capture records nothing however the setting reads, and telling an
  // operator their prompts are being kept when they are not is the worse lie of
  // the two. Unknown — the settings read failed — is reported as not recording.
  const capturing = useBodyLoggingActive();
  const now = useCurrentTime(liveUpdates && rows.some(isPending));

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

  const failed = rows.filter(isError).length;
  const live = rows.filter(isPending).length;

  return (
    <>
      <PageHead
        legend="Logs"
        title="Recent requests"
        summary={
          logs.isLoading
            ? "Reading the request log…"
            : `${formatCount(rows.length)} requests loaded, ${formatCount(failed)} of them failed${live === 0 ? "" : `, ${formatCount(live)} still running`}. ${capturing.data === true ? "Body capture is on: open a request to read what it sent and received." : "Prompt and response bodies are not being recorded."}`
        }
        actions={
          <Controls>
            <LogFilterBar filters={filters} onChange={setFilters} operator />
            <Narrow
              value={limit}
              aria-label="How many requests per page"
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {LIMITS.map((value) => (
                <option key={value} value={value}>
                  {value} per page
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
              // With the gateway doing the matching, "no rows" no longer implies
              // "no rows in the fetched window" — an unfiltered read that comes
              // back empty means the log itself is empty, and that is a
              // different thing to tell an operator than a filter that missed.
              Object.keys(filters).length === 0
                ? "No requests have reached the gateway yet."
                : "No request matches these filters. Clear them to see everything."
            }
          />
        ) : (
          <RequestLogScroller data-testid="request-log-scroller">
            <RequestTable rows={rows} now={now} names={names} onOpen={setOpen} />
            {logs.hasNextPage || paused ? (
              <More>
                {logs.hasNextPage ? (
                  <Button
                    type="button"
                    disabled={logs.isFetchingNextPage}
                    onClick={() => void logs.fetchNextPage()}
                  >
                    {logs.isFetchingNextPage ? "Loading…" : "Load older"}
                  </Button>
                ) : null}
                {paused ? (
                  <>
                    <Muted>Live updates are paused while older pages are loaded.</Muted>
                    <Button type="button" onClick={backToHead}>
                      Back to live
                    </Button>
                  </>
                ) : null}
              </More>
            ) : null}
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
