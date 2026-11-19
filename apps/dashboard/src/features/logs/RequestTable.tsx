import { useEffect, useState } from "react";
import styled from "styled-components";
import type { RequestRow } from "../../api/types.ts";
import { CopyInline } from "../../components/CopyInline.tsx";
import {
  formatClock,
  formatCount,
  formatDateTime,
  formatDuration,
  formatMs,
  formatUsd,
  shortId,
} from "../../lib/format.ts";
import { isPending, lampLabel, lampState } from "../../lib/vitals.ts";
import { Chip, ProviderTag } from "../../ui/Chip.tsx";
import { Lamp } from "../../ui/Lamp.tsx";
import { Legend, Mono, Row, Stack, Truncate } from "../../ui/primitives.ts";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";
import { ProcessingTokens, TokenBreakdown, tokenBreakdownLabel } from "../../ui/TokenBreakdown.tsx";

/**
 * The labels a row can be annotated with, where the reader is entitled to them.
 *
 * Absent — not empty — on the client surface, which holds one key and may not
 * read the operator's accounts at all. The two columns and their detail rows
 * are then not rendered, rather than rendered as dashes: a column of dashes
 * invites the question "whose account was it", which is exactly the question
 * this surface does not answer.
 */
export type RequestNames = {
  /** Account labels by credential id. */
  accounts: ReadonlyMap<string, string>;
  /** Key labels by api key id. */
  keys: ReadonlyMap<string, string>;
};

/**
 * A clock that only ticks while something is in flight.
 *
 * A running request has no duration yet, so its cell counts up from `at`. When
 * nothing is pending there is nothing to recompute and the interval is not
 * installed at all.
 */
export function useCurrentTime(active: boolean): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [active]);

  return now;
}

function TokenCell({ log }: { log: RequestRow }) {
  return (
    <Td
      $align="right"
      $mono
      {...(isPending(log) ? { "aria-label": "processing" } : { title: tokenBreakdownLabel(log) })}
    >
      {isPending(log) ? <ProcessingTokens /> : <TokenBreakdown tokens={log} />}
    </Td>
  );
}

export type RequestTableProps = {
  rows: readonly RequestRow[];
  /** Ticks only while a row is still running; see `useCurrentTime`. */
  now: number;
  names?: RequestNames;
  onOpen: (log: RequestRow) => void;
  /**
   * Narrows the log to one session. When present, the Session column renders
   * each id as a button that filters rather than opening the row.
   */
  onSession?: (sessionId: string) => void;
};

/** A session id in a cell: the tail is what tells sessions apart, so keep it visible. */
const SessionButton = styled.button`
  all: unset;
  cursor: pointer;
  display: block;
  max-width: 18ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.color.inkDim};
  &:hover,
  &:focus-visible {
    color: ${({ theme }) => theme.color.accent};
    text-decoration: underline;
  }
`;

/**
 * One row per request, most recent first.
 *
 * Shared by the operator's log page and the client's own screen. The only
 * difference between them is `names`: everything else on a row — the lamp, the
 * provider tag, the token breakdown, the outcome chip — describes the request
 * rather than the installation that served it.
 */
export function RequestTable({ rows, now, names, onOpen, onSession }: RequestTableProps) {
  return (
    <Table>
      <thead>
        <tr>
          <Th />
          <Th $align="right">Time</Th>
          <Th>Requested</Th>
          <Th>Routed to</Th>
          <Th>Session</Th>
          {names === undefined ? null : (
            <>
              <Th>Account</Th>
              <Th>Key</Th>
            </>
          )}
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
          <Tr key={log.id} $selectable onClick={() => onOpen(log)}>
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
              {log.sessionId === null ? (
                <Legend>—</Legend>
              ) : onSession === undefined ? (
                <Truncate style={{ display: "block", maxWidth: "18ch" }} title={log.sessionId}>
                  {log.sessionId}
                </Truncate>
              ) : (
                <SessionButton
                  type="button"
                  title={log.sessionId}
                  aria-label={`Filter by session ${log.sessionId}`}
                  onClick={(event) => {
                    // The row opens on click; this cell filters instead.
                    event.stopPropagation();
                    onSession(log.sessionId ?? "");
                  }}
                >
                  {/* `rtl` keeps the distinguishing tail visible; the bidi
                      isolate stops it reordering the id's own characters. */}
                  <bdi>{log.sessionId}</bdi>
                </SessionButton>
              )}
            </Td>
            {names === undefined ? null : (
              <>
                <Td>
                  <Truncate style={{ display: "block", maxWidth: "18ch" }}>
                    {log.credentialId == null
                      ? "—"
                      : (names.accounts.get(log.credentialId) ?? shortId(log.credentialId))}
                  </Truncate>
                </Td>
                {/* A key that has since been revoked keeps its requests in
                    the log, and the label goes with it. The id is the
                    fallback, and the title, so a renamed key is still
                    traceable to the row that named it. */}
                <Td>
                  <Truncate
                    style={{ display: "block", maxWidth: "16ch" }}
                    title={log.apiKeyId ?? undefined}
                  >
                    {log.apiKeyId == null
                      ? "—"
                      : (names.keys.get(log.apiKeyId) ?? shortId(log.apiKeyId))}
                  </Truncate>
                </Td>
              </>
            )}
            <Td $align="right" $mono>
              {isPending(log) ? "—" : log.attempts}
            </Td>
            <Td $align="right" $mono>
              {isPending(log) ? "—" : formatMs(log.ttftMs)}
            </Td>
            <Td $align="right" $mono>
              {isPending(log)
                ? formatDuration(Math.max(0, now - log.at))
                : formatMs(log.durationMs)}
            </Td>
            <TokenCell log={log} />
            <Td $align="right" $mono>
              {isPending(log) ? "—" : formatUsd(log.costUsd)}
            </Td>
            <Td>
              {isPending(log) ? (
                <Chip $tone="accent">live</Chip>
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
  );
}

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

export type RequestDetailProps = {
  log: RequestRow;
  names?: RequestNames;
  /**
   * What the surface has to add below the metadata.
   *
   * The operator's page passes the captured bodies. The client surface passes
   * nothing at all, and that is the point: `/api/client/*` has no body route,
   * so there is no affordance here for anyone to later make conditional.
   */
  children?: React.ReactNode;
};

/** Everything recorded about one request, as the row was when it was opened. */
export function RequestDetail({ log, names, children }: RequestDetailProps) {
  return (
    <Stack $gap={3}>
      <Detail>
        <Legend as="dt">Request id</Legend>
        <Value>
          <CopyInline value={log.id} label="Copy request id" />
        </Value>
        <Legend as="dt">At</Legend>
        <Value>{formatDateTime(log.at)}</Value>
        <Legend as="dt">Requested model</Legend>
        <Value>{log.requestedModel || "—"}</Value>
        <Legend as="dt">Routed to</Legend>
        <Value>
          {isPending(log)
            ? "—"
            : log.resolvedProvider === null
              ? "not routed"
              : `${log.resolvedProvider} · ${log.resolvedModel ?? "—"}`}
        </Value>
        {names === undefined ? null : (
          <>
            <Legend as="dt">Account</Legend>
            <Value>
              {log.credentialId == null
                ? "—"
                : (names.accounts.get(log.credentialId) ?? log.credentialId)}
            </Value>
            <Legend as="dt">Key</Legend>
            <Value>
              {log.apiKeyId == null ? "—" : (names.keys.get(log.apiKeyId) ?? log.apiKeyId)}
            </Value>
          </>
        )}
        <Legend as="dt">Attempts</Legend>
        <Value>{isPending(log) ? "—" : log.attempts}</Value>
        <Legend as="dt">Status</Legend>
        {/* The snapshot the row was opened with. The log behind this
            refreshes on the next poll; the modal does not. */}
        <Value>
          {isPending(log)
            ? "in flight"
            : log.errorCode === null
              ? log.status
              : `${log.status} ${log.errorCode}`}
        </Value>
        <Legend as="dt">Timing</Legend>
        <Value>
          {isPending(log)
            ? "—"
            : `first token ${formatMs(log.ttftMs)} · total ${formatMs(log.durationMs)}`}
        </Value>
        <Legend as="dt">Tokens</Legend>
        <Value>
          {isPending(log) ? (
            "—"
          ) : (
            <>
              {formatCount(log.inputTokens)} in · {formatCount(log.outputTokens)} out ·{" "}
              {formatCount(log.cacheReadTokens)} cache read · {formatCount(log.cacheWriteTokens)}{" "}
              cache write
            </>
          )}
        </Value>
        <Legend as="dt">Cost</Legend>
        <Value>{isPending(log) ? "—" : formatUsd(log.costUsd)}</Value>
        {/*
          The compression figures and the filter list are on the operator's row
          and not on the client's: `toClientLog` enumerates what a key holder may
          see, and these four columns are not in it. Guarded on the field rather
          than on which surface is rendering, for the reason the Account and Key
          columns are — a component that asked "am I the console?" would answer
          it once and be wrong the next time a projection changed.
        */}
        <Legend as="dt">RTK compression</Legend>
        <Value>
          {isPending(log)
            ? "—"
            : !log.rtkApplied
              ? "not applied"
              : log.rtkFilterHits === undefined
                ? // What the client's row carries: the saving, without the
                  // code-unit accounting behind it.
                  `~${formatCount(log.rtkEstimatedTokensSaved)} tokens saved`
                : `${formatCount(log.rtkFilterHits)} hits · ${formatCount(log.rtkOriginalCodeUnits ?? 0)} → ${formatCount(log.rtkCompressedCodeUnits ?? 0)} code units · ~${formatCount(log.rtkEstimatedTokensSaved)} tokens saved`}
        </Value>
        {log.rtkFilters === undefined ? null : (
          <>
            <Legend as="dt">RTK filters</Legend>
            <Value>{log.rtkFilters.length === 0 ? "—" : log.rtkFilters.join(", ")}</Value>
          </>
        )}
        {/* What the caller said this request belongs to. Every field is
            caller-supplied grouping, so it is shown exactly as sent. */}
        <Legend as="dt">Session</Legend>
        <Value>
          {log.sessionId === null ? "—" : <CopyInline value={log.sessionId} label="Copy session" />}
        </Value>
        <Legend as="dt">Turn</Legend>
        <Value>
          {log.turnId === null ? "—" : <CopyInline value={log.turnId} label="Copy turn" />}
        </Value>
        <Legend as="dt">Agent</Legend>
        <Value>{log.agent ?? "—"}</Value>
        <Legend as="dt">Client request id</Legend>
        <Value>
          {log.clientRequestId === null ? (
            "—"
          ) : (
            <CopyInline value={log.clientRequestId} label="Copy client request id" />
          )}
        </Value>
        {/* The provider's id names a request on the operator's account. It is
            on the operator's row only; guarded on the field, like RTK filters. */}
        {log.upstreamRequestId === undefined ? null : (
          <>
            <Legend as="dt">Provider request id</Legend>
            <Value>
              {log.upstreamRequestId === null ? (
                "—"
              ) : (
                <CopyInline value={log.upstreamRequestId} label="Copy provider request id" />
              )}
            </Value>
          </>
        )}
      </Detail>

      {log.tags.length === 0 && Object.keys(log.traceMetadata).length === 0 ? null : (
        <Stack $gap={1}>
          <Row $gap={2} $wrap>
            <Legend>Tags and metadata</Legend>
            {/* Copied in the header syntax the caller sends, so a value can be
                pasted straight back into `x-omni-tags` / `x-omni-metadata`. */}
            {log.tags.length === 0 ? null : (
              <CopyInline value={log.tags.join(",")} label="Copy tags" showValue={false} />
            )}
            {Object.keys(log.traceMetadata).length === 0 ? null : (
              <CopyInline
                value={Object.entries(log.traceMetadata)
                  .map(([key, value]) => `${encodeURIComponent(key)}:${encodeURIComponent(value)}`)
                  .join(",")}
                label="Copy metadata"
                showValue={false}
              />
            )}
          </Row>
          <Row $gap={1} $wrap>
            {log.tags.map((tag) => (
              <Chip key={`tag:${tag}`}>{tag}</Chip>
            ))}
            {Object.entries(log.traceMetadata).map(([key, value]) => (
              <Chip key={`meta:${key}`} $tone="accent">{`${key}: ${value}`}</Chip>
            ))}
          </Row>
        </Stack>
      )}

      {log.degradations.length === 0 ? null : (
        <Stack $gap={1}>
          <Legend>Capabilities dropped to fit the target</Legend>
          <Row $gap={1} $wrap>
            {log.degradations.map((degradation) => (
              <Chip key={degradation} $tone="warn">
                {degradation}
              </Chip>
            ))}
          </Row>
        </Stack>
      )}

      {children}
    </Stack>
  );
}
