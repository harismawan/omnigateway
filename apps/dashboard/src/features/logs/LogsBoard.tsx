import { useMemo, useState } from "react";
import styled from "styled-components";
import { LOG_CADENCE_MS, useCredentials, useLogs } from "../../api/queries.ts";
import type { RequestLog } from "../../api/types.ts";
import { PageHead } from "../../components/Rack.tsx";
import {
  formatClock,
  formatCount,
  formatDateTime,
  formatMs,
  formatUsd,
  shortId,
} from "../../lib/format.ts";
import { isError, isPending, lampLabel, lampState } from "../../lib/vitals.ts";
import { useLive } from "../../session/live.tsx";
import { Button } from "../../ui/Button.tsx";
import { Chip, ProviderTag } from "../../ui/Chip.tsx";
import { Input, Select } from "../../ui/Field.tsx";
import { Lamp } from "../../ui/Lamp.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Mono, Row, ScrollX, Stack, Truncate } from "../../ui/primitives.ts";
import { Empty, Failure, SkeletonRows } from "../../ui/States.tsx";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";

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

const Detail = styled.dl`
  display: grid;
  grid-template-columns: minmax(120px, auto) minmax(0, 1fr);
  gap: 6px ${({ theme }) => theme.space(3)};
  margin: 0;
  font-size: 12.5px;
`;

const Value = styled.dd`
  margin: 0;
  font-family: ${({ theme }) => theme.font.mono};
  word-break: break-all;
`;

/** One row per request, most recent first. Polling is the only feed available. */
export function LogsBoard() {
  const { cadence } = useLive();
  const [limit, setLimit] = useState<number>(100);
  const [filter, setFilter] = useState<Filter>("all");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState<RequestLog | null>(null);

  const logs = useLogs(limit, cadence(LOG_CADENCE_MS));
  const credentials = useCredentials();

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const credential of credentials.data ?? []) map.set(credential.id, credential.label);
    return map;
  }, [credentials.data]);

  const needle = term.trim().toLowerCase();
  const rows = (logs.data ?? []).filter((log) => {
    if (filter === "failed" && !isError(log)) return false;
    if (needle.length === 0) return true;
    return (
      log.requestedModel.toLowerCase().includes(needle) ||
      (log.resolvedModel ?? "").toLowerCase().includes(needle) ||
      (log.errorCode ?? "").toLowerCase().includes(needle) ||
      (log.credentialId === null ? "" : (names.get(log.credentialId) ?? ""))
        .toLowerCase()
        .includes(needle)
    );
  });

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
            : `${formatCount(logs.data?.length ?? 0)} recent requests, ${formatCount(failed)} of them failed${live === 0 ? "" : `, ${formatCount(live)} still running`}. Prompt and response bodies are never recorded.`
        }
        actions={
          <Controls>
            <Search
              value={term}
              placeholder="Filter by model, account, or error"
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

      <Module legend="Request log" meta={`${rows.length} shown`} flush>
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
          <ScrollX>
            <Table>
              <thead>
                <tr>
                  <Th />
                  <Th $align="right">Time</Th>
                  <Th>Requested</Th>
                  <Th>Routed to</Th>
                  <Th>Account</Th>
                  <Th $align="right">Try</Th>
                  <Th $align="right">TTFT</Th>
                  <Th $align="right">Total</Th>
                  <Th $align="right">Tokens</Th>
                  <Th $align="right">Cost</Th>
                  <Th>Outcome</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((log) => (
                  <Tr key={log.id} $selectable onClick={() => setOpen(log)}>
                    <Td>
                      <Lamp state={lampState(log)} label={lampLabel(log)} />
                    </Td>
                    {/* Clock only: every row in a tail shares the day, and the
                        full stamp is a hover away. */}
                    <Td $align="right" $mono title={formatDateTime(log.at)}>
                      {formatClock(log.at)}
                    </Td>
                    <Td $mono>
                      <Truncate style={{ display: "block", maxWidth: "20ch" }}>
                        {log.requestedModel || "—"}
                      </Truncate>
                    </Td>
                    {/* A row still in flight has been measured for none of
                        what follows. Its zeros are placeholders the gateway
                        filed to keep the column NOT NULL, so printing them
                        would state a nought that nobody counted. */}
                    <Td>
                      {log.resolvedProvider === null ? (
                        <Legend>{isPending(log) ? "routing…" : "not routed"}</Legend>
                      ) : (
                        <Row $gap={1}>
                          <ProviderTag provider={log.resolvedProvider} />
                          <Mono $dim>{log.resolvedModel ?? "—"}</Mono>
                        </Row>
                      )}
                    </Td>
                    <Td>
                      <Truncate style={{ display: "block", maxWidth: "18ch" }}>
                        {log.credentialId === null
                          ? "—"
                          : (names.get(log.credentialId) ?? shortId(log.credentialId))}
                      </Truncate>
                    </Td>
                    <Td $align="right" $mono>
                      {isPending(log) ? "—" : log.attempts}
                    </Td>
                    <Td $align="right" $mono>
                      {isPending(log) ? "—" : formatMs(log.ttftMs)}
                    </Td>
                    <Td $align="right" $mono>
                      {isPending(log) ? "—" : formatMs(log.durationMs)}
                    </Td>
                    <Td $align="right" $mono>
                      {isPending(log) ? "—" : formatCount(log.inputTokens + log.outputTokens)}
                    </Td>
                    <Td $align="right" $mono>
                      {isPending(log) ? "—" : formatUsd(log.costUsd)}
                    </Td>
                    <Td>
                      {isPending(log) ? (
                        <Chip $tone="neutral">live</Chip>
                      ) : log.errorCode === null ? (
                        <Chip $tone="ok">{log.status}</Chip>
                      ) : (
                        <Chip $tone="down">{log.errorCode}</Chip>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </ScrollX>
        )}
      </Module>

      <Modal
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        title="Request detail"
        width="600px"
        footer={
          <Button type="button" onClick={() => setOpen(null)}>
            Close
          </Button>
        }
      >
        {open === null ? null : (
          <Stack $gap={3}>
            <Detail>
              <Legend as="dt">Request id</Legend>
              <Value>{open.id}</Value>
              <Legend as="dt">At</Legend>
              <Value>{formatDateTime(open.at)}</Value>
              <Legend as="dt">Requested model</Legend>
              <Value>{open.requestedModel || "—"}</Value>
              <Legend as="dt">Routed to</Legend>
              <Value>
                {isPending(open)
                  ? "—"
                  : open.resolvedProvider === null
                    ? "not routed"
                    : `${open.resolvedProvider} · ${open.resolvedModel ?? "—"}`}
              </Value>
              <Legend as="dt">Account</Legend>
              <Value>
                {open.credentialId === null
                  ? "—"
                  : (names.get(open.credentialId) ?? open.credentialId)}
              </Value>
              <Legend as="dt">Key</Legend>
              <Value>{open.apiKeyId ?? "—"}</Value>
              <Legend as="dt">Attempts</Legend>
              <Value>{isPending(open) ? "—" : open.attempts}</Value>
              <Legend as="dt">Status</Legend>
              {/* The snapshot the row was opened with. The log behind this
                  refreshes on the next poll; the modal does not. */}
              <Value>
                {isPending(open)
                  ? "in flight"
                  : open.errorCode === null
                    ? open.status
                    : `${open.status} ${open.errorCode}`}
              </Value>
              <Legend as="dt">Timing</Legend>
              <Value>
                {isPending(open)
                  ? "—"
                  : `first token ${formatMs(open.ttftMs)} · total ${formatMs(open.durationMs)}`}
              </Value>
              <Legend as="dt">Tokens</Legend>
              <Value>
                {isPending(open) ? (
                  "—"
                ) : (
                  <>
                    {formatCount(open.inputTokens)} in · {formatCount(open.outputTokens)} out ·{" "}
                    {formatCount(open.cacheReadTokens)} cache read ·{" "}
                    {formatCount(open.cacheWriteTokens)} cache write
                  </>
                )}
              </Value>
              <Legend as="dt">Cost</Legend>
              <Value>{isPending(open) ? "—" : formatUsd(open.costUsd)}</Value>
            </Detail>

            {open.degradations.length === 0 ? null : (
              <Stack $gap={1}>
                <Legend>Capabilities dropped to fit the target</Legend>
                <Row $gap={1} $wrap>
                  {open.degradations.map((degradation) => (
                    <Chip key={degradation} $tone="warn">
                      {degradation}
                    </Chip>
                  ))}
                </Row>
              </Stack>
            )}
          </Stack>
        )}
      </Modal>
    </>
  );
}
