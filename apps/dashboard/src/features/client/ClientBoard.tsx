import { useMemo, useState } from "react";
import styled from "styled-components";
import {
  useClientLogs,
  useClientQuota,
  useClientSummary,
  useClientUsage,
} from "../../api/queries.ts";
import type { LimitReading, ProviderHeadroom, RequestLog, UsageBucket } from "../../api/types.ts";
import { formatCount, formatPercent, formatRelative, formatUsd } from "../../lib/format.ts";
import { useLive } from "../../session/live.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Grid, Legend, Mono, Muted, Row, ScrollX, Stack } from "../../ui/primitives.ts";
import { Readout } from "../../ui/Readout.tsx";
import { Empty, Failure, SkeletonRows } from "../../ui/States.tsx";

const DAY_MS = 86_400_000;

const RANGES = [
  { id: "24h", label: "24 hours", spanMs: DAY_MS },
  { id: "7d", label: "7 days", spanMs: 7 * DAY_MS },
  { id: "30d", label: "30 days", spanMs: 30 * DAY_MS },
] as const;

type RangeId = (typeof RANGES)[number]["id"];

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  th,
  td {
    text-align: left;
    padding: ${({ theme }) => theme.space(1)} ${({ theme }) => theme.space(2)};
    border-bottom: 1px solid ${({ theme }) => theme.color.rule};
    white-space: nowrap;
  }
  th {
    color: ${({ theme }) => theme.color.inkDim};
    font-weight: 500;
  }
  td.num,
  th.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
`;

/**
 * A limit's consumption as a bar.
 *
 * Colour means state here, which is the one thing it is allowed to mean: green
 * until the ceiling is in sight, amber approaching it, red at it.
 */
const Meter = styled.div<{ $percent: number }>`
  height: 4px;
  border-radius: 2px;
  background: ${({ theme }) => theme.color.rule};
  overflow: hidden;
  &::after {
    content: "";
    display: block;
    height: 100%;
    width: ${({ $percent }) => Math.min(100, Math.max(0, $percent))}%;
    background: ${({ theme, $percent }) =>
      $percent >= 90 ? theme.color.down : $percent >= 70 ? theme.color.warn : theme.color.ok};
  }
`;

const Choice = styled.button<{ $on?: boolean }>`
  border: 1px solid
    ${({ theme, $on }) => ($on === true ? theme.color.accent : theme.color.rule)};
  background: ${({ theme, $on }) => ($on === true ? theme.color.accentWash : "transparent")};
  color: ${({ theme, $on }) => ($on === true ? theme.color.ink : theme.color.inkDim)};
  border-radius: ${({ theme }) => theme.radius.control};
  padding: ${({ theme }) => theme.space(1)} ${({ theme }) => theme.space(2)};
  cursor: pointer;
  font: inherit;
`;

function totalsOf(buckets: readonly UsageBucket[]) {
  return buckets.reduce(
    (sum, bucket) => ({
      requests: sum.requests + bucket.requests,
      tokens:
        sum.tokens +
        bucket.inputTokens +
        bucket.outputTokens +
        bucket.cacheReadTokens +
        bucket.cacheWriteTokens,
      costUsd: sum.costUsd + bucket.costUsd,
      errors: sum.errors + bucket.errors,
    }),
    { requests: 0, tokens: 0, costUsd: 0, errors: 0 },
  );
}

function tokensOf(bucket: UsageBucket): number {
  return (
    bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens
  );
}

/** The window a limit is counted over, spelled for a reader rather than a schema. */
const WINDOW_LABEL: Readonly<Record<string, string>> = {
  "1m": "per minute",
  "5h": "per 5 hours",
  "1w": "per week",
};

function LimitRow({ reading }: { reading: LimitReading }) {
  const label =
    reading.window === null
      ? "concurrent requests"
      : `${reading.dimension} ${WINDOW_LABEL[reading.window] ?? reading.window}`;
  const show = reading.dimension === "spend" ? formatUsd : formatCount;

  return (
    <tr>
      <td>{label}</td>
      <td className="num">
        {/*
          Null is not zero. `concurrency` is a gauge held in the gateway process
          with no row behind it, so rendering 0 would tell a client they have
          nothing in flight when nobody actually knows.
        */}
        {reading.used === null ? <Muted>unknown</Muted> : show(reading.used)}
      </td>
      <td className="num">{show(reading.limit)}</td>
      <td style={{ width: "30%" }}>
        {reading.used === null ? null : (
          <Meter $percent={reading.limit === 0 ? 100 : (reading.used / reading.limit) * 100} />
        )}
      </td>
    </tr>
  );
}

function HeadroomRow({ row }: { row: ProviderHeadroom }) {
  return (
    <tr>
      <td>{row.provider}</td>
      <td>{row.windowType}</td>
      <td className="num">
        {/* Unknown, never "plenty": a provider that named no ceiling told us nothing. */}
        {row.usedRatio === null ? <Muted>unknown</Muted> : formatPercent(row.usedRatio, 0)}
      </td>
      <td>{row.resetsAt === null ? <Muted>—</Muted> : formatRelative(row.resetsAt)}</td>
    </tr>
  );
}

function LogRow({ row }: { row: RequestLog }) {
  return (
    <tr>
      <td>{formatRelative(row.at)}</td>
      <td>
        <Mono>{row.requestedModel}</Mono>
      </td>
      <td>{row.resolvedProvider ?? <Muted>—</Muted>}</td>
      <td className="num">{row.status}</td>
      <td className="num">{formatCount(row.inputTokens + row.outputTokens)}</td>
      <td className="num">{formatUsd(row.costUsd)}</td>
    </tr>
  );
}

/**
 * What the holder of one API key sees about their own traffic.
 *
 * Deliberately one screen rather than the console's nine. A client has one key,
 * so a navigation rail over four panels would be furniture around a single
 * question: how much have I used, and am I about to be stopped.
 */
export function ClientBoard() {
  const { cadence } = useLive();
  const [rangeId, setRangeId] = useState<RangeId>("7d");

  const span = RANGES.find((entry) => entry.id === rangeId)?.spanMs ?? 7 * DAY_MS;
  // Pinned to the minute so the query key does not change on every render.
  const since = useMemo(() => Math.floor((Date.now() - span) / 60_000) * 60_000, [span]);

  const summary = useClientSummary();
  const usage = useClientUsage({ groupBy: "model", since }, cadence(60_000, "res:usage"));
  const logs = useClientLogs(50, cadence(5_000, "res:logs"));
  // Polled, with no topic. A client holds `res:usage` and `res:logs` and nothing
  // else, so naming `res:quota` here would switch polling off in favour of a
  // push that never arrives, and the panel would sit frozen with no error.
  const quota = useClientQuota(60_000);

  const sums = totalsOf(usage.data ?? []);
  const rangeLabel = RANGES.find((entry) => entry.id === rangeId)?.label;

  return (
    <Stack $gap={3}>
      <Module
        legend="Your key"
        meta={summary.data === undefined ? undefined : <Mono $dim>{summary.data.prefix}…</Mono>}
      >
        {summary.isPending ? (
          <SkeletonRows rows={2} />
        ) : summary.isError ? (
          <Failure legend="Could not read your key" error={summary.error} />
        ) : (
          <Stack $gap={2}>
            <Row $gap={2} $wrap>
              <Legend>{summary.data.label}</Legend>
              {summary.data.bodyLoggingOptOut ? (
                <Muted>Request bodies are never stored for this key.</Muted>
              ) : null}
            </Row>
            {summary.data.modelAllowlist === null ? (
              <Muted>Every model this gateway serves.</Muted>
            ) : summary.data.modelAllowlist.length === 0 ? (
              // `[]` and `null` are opposite facts and must not render alike.
              <Muted>No models. This key cannot serve a request.</Muted>
            ) : (
              <Row $gap={1} $wrap>
                {summary.data.modelAllowlist.map((model) => (
                  <Mono key={model}>{model}</Mono>
                ))}
              </Row>
            )}
          </Stack>
        )}
      </Module>

      <Row $gap={1} $wrap>
        {RANGES.map((entry) => (
          <Choice
            key={entry.id}
            type="button"
            $on={entry.id === rangeId}
            aria-pressed={entry.id === rangeId}
            onClick={() => setRangeId(entry.id)}
          >
            {entry.label}
          </Choice>
        ))}
      </Row>

      <Grid $min="180px">
        <Readout legend="Requests" value={formatCount(sums.requests)} />
        <Readout legend="Tokens" value={formatCount(sums.tokens)} />
        <Readout legend="Spend" value={formatUsd(sums.costUsd)} />
        <Readout
          legend="Errors"
          value={formatCount(sums.errors)}
          {...(sums.errors > 0 ? { tone: "warn" as const } : {})}
        />
      </Grid>

      <Module legend="By model" meta={rangeLabel}>
        {usage.isPending ? (
          <SkeletonRows />
        ) : usage.isError ? (
          <Failure legend="Could not read usage" error={usage.error} />
        ) : (usage.data ?? []).length === 0 ? (
          <Empty legend="No traffic" message="Nothing served in this window." />
        ) : (
          <ScrollX>
            <Table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="num">Requests</th>
                  <th className="num">Tokens</th>
                  <th className="num">Spend</th>
                </tr>
              </thead>
              <tbody>
                {(usage.data ?? []).map((bucket) => (
                  <tr key={bucket.key}>
                    <td>
                      <Mono>{bucket.key}</Mono>
                    </td>
                    <td className="num">{formatCount(bucket.requests)}</td>
                    <td className="num">{formatCount(tokensOf(bucket))}</td>
                    <td className="num">{formatUsd(bucket.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </ScrollX>
        )}
      </Module>

      <Module legend="Your limits">
        {summary.isPending ? (
          <SkeletonRows rows={3} />
        ) : summary.isError ? (
          <Failure legend="Could not read your limits" error={summary.error} />
        ) : summary.data.limits === null ? (
          // Distinct from "no limits". An unparseable matrix is refused at
          // `/v1`, so reporting "unlimited" here would contradict every request.
          <Empty
            legend="Limits unreadable"
            message="This key's limits could not be read. Requests are refused until an operator repairs it."
          />
        ) : summary.data.limitUsage.length === 0 ? (
          <Empty legend="No limits" message="This key is not rate limited." />
        ) : (
          <ScrollX>
            <Table>
              <thead>
                <tr>
                  <th>Limit</th>
                  <th className="num">Used</th>
                  <th className="num">Ceiling</th>
                  <th aria-label="Consumption" />
                </tr>
              </thead>
              <tbody>
                {summary.data.limitUsage.map((reading) => (
                  <LimitRow
                    key={`${reading.dimension}:${reading.window ?? "gauge"}`}
                    reading={reading}
                  />
                ))}
              </tbody>
            </Table>
          </ScrollX>
        )}
        <Muted>
          Counted from completed requests, so a burst in flight right now may not be included yet.
        </Muted>
      </Module>

      <Module legend="Provider headroom">
        {quota.isPending ? (
          <SkeletonRows rows={2} />
        ) : quota.isError ? (
          <Failure legend="Could not read provider headroom" error={quota.error} />
        ) : (quota.data ?? []).length === 0 ? (
          <Empty legend="No data" message="No provider has reported a usage window." />
        ) : (
          <ScrollX>
            <Table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Window</th>
                  <th className="num">Used</th>
                  <th>Resets</th>
                </tr>
              </thead>
              <tbody>
                {(quota.data ?? []).map((row) => (
                  <HeadroomRow key={`${row.provider}:${row.windowType}`} row={row} />
                ))}
              </tbody>
            </Table>
          </ScrollX>
        )}
        <Muted>The best headroom available across the accounts serving each provider.</Muted>
      </Module>

      <Module legend="Recent requests" meta={`${(logs.data ?? []).length} shown`}>
        {logs.isPending ? (
          <SkeletonRows />
        ) : logs.isError ? (
          <Failure legend="Could not read your requests" error={logs.error} />
        ) : (logs.data ?? []).length === 0 ? (
          <Empty legend="No requests" message="Nothing served through this key yet." />
        ) : (
          <ScrollX>
            <Table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Model</th>
                  <th>Provider</th>
                  <th className="num">Status</th>
                  <th className="num">Tokens</th>
                  <th className="num">Spend</th>
                </tr>
              </thead>
              <tbody>
                {(logs.data ?? []).map((row) => (
                  <LogRow key={row.id} row={row} />
                ))}
              </tbody>
            </Table>
          </ScrollX>
        )}
      </Module>
    </Stack>
  );
}
