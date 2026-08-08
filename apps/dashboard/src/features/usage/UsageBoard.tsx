import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import styled from "styled-components";
import { useCredentials, useKeys, useUsage } from "../../api/queries.ts";
import type { UsageBucket, UsageGroupBy } from "../../api/types.ts";
import { PageHead } from "../../components/Rack.tsx";
import { formatCount, formatUsd } from "../../lib/format.ts";
import { useLive } from "../../session/live.tsx";
import { Button } from "../../ui/Button.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Row, ScrollX, Stack, Truncate } from "../../ui/primitives.ts";
import { Empty, Failure, SkeletonRows } from "../../ui/States.tsx";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";

const RANGES = [
  { id: "1h", label: "1 hour", ms: 3_600_000 },
  { id: "24h", label: "24 hours", ms: 86_400_000 },
  { id: "7d", label: "7 days", ms: 604_800_000 },
  { id: "30d", label: "30 days", ms: 2_592_000_000 },
] as const;

type RangeId = (typeof RANGES)[number]["id"];

const GROUPS: ReadonlyArray<{ id: UsageGroupBy; label: string; column: string }> = [
  { id: "hour", label: "Over time", column: "Hour" },
  { id: "model", label: "By upstream model", column: "Upstream model" },
  { id: "credential", label: "By account", column: "Account" },
  { id: "apiKey", label: "By key", column: "Key" },
];

const Controls = styled(Row)`
  gap: ${({ theme }) => theme.space(1)};
  flex-wrap: wrap;
`;

const Segment = styled(Button)<{ $on: boolean }>`
  border-color: ${({ theme, $on }) => ($on ? theme.color.accent : theme.color.ruleStrong)};
  color: ${({ theme, $on }) => ($on ? theme.color.accent : theme.color.inkDim)};
  background: ${({ theme, $on }) => ($on ? theme.color.accentWash : theme.color.panelRaised)};
`;

const ChartBox = styled.div`
  height: 260px;
  width: 100%;
`;

const TipCard = styled.div`
  background: ${({ theme }) => theme.color.panel};
  border: 1px solid ${({ theme }) => theme.color.ruleStrong};
  border-radius: ${({ theme }) => theme.radius.control};
  padding: ${({ theme }) => theme.space(2)};
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 11.5px;
  box-shadow: ${({ theme }) => theme.color.shadow};
`;

type Point = {
  label: string;
  requests: number;
  /** Split out so the stack totals `requests` instead of double-counting it. */
  succeeded: number;
  errors: number;
  costUsd: number;
  tokens: number;
};

function hourLabel(key: string): string {
  const at = Number(key) * 3_600_000;
  if (!Number.isFinite(at)) return key;
  return new Date(at).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    hour12: false,
  });
}

export function UsageBoard() {
  const { cadence } = useLive();
  const [range, setRange] = useState<RangeId>("24h");
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("hour");

  const spanMs = RANGES.find((entry) => entry.id === range)?.ms ?? 86_400_000;
  // Pinned per render pass so the query key does not change on every tick.
  const since = useMemo(() => Math.floor((Date.now() - spanMs) / 60_000) * 60_000, [spanMs]);

  const usage = useUsage({ groupBy, since }, cadence(60_000));
  const credentials = useCredentials();
  const keys = useKeys();

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const credential of credentials.data ?? []) map.set(credential.id, credential.label);
    for (const key of keys.data ?? []) map.set(key.id, key.label);
    return map;
  }, [credentials.data, keys.data]);

  const rows = usage.data ?? [];
  const naming = (bucket: UsageBucket): string =>
    groupBy === "hour" ? hourLabel(bucket.key) : (names.get(bucket.key) ?? bucket.key);

  const ordered =
    groupBy === "hour" ? [...rows].sort((a, b) => Number(a.key) - Number(b.key)) : rows;

  const points: Point[] = ordered.map((bucket) => ({
    label: naming(bucket),
    requests: bucket.requests,
    succeeded: Math.max(0, bucket.requests - bucket.errors),
    errors: bucket.errors,
    costUsd: bucket.costUsd,
    tokens: bucket.inputTokens + bucket.outputTokens,
  }));

  const totals = rows.reduce(
    (sum, bucket) => ({
      requests: sum.requests + bucket.requests,
      errors: sum.errors + bucket.errors,
      costUsd: sum.costUsd + bucket.costUsd,
      tokens: sum.tokens + bucket.inputTokens + bucket.outputTokens,
    }),
    { requests: 0, errors: 0, costUsd: 0, tokens: 0 },
  );

  const groupLabel = GROUPS.find((entry) => entry.id === groupBy);

  return (
    <>
      <PageHead
        legend="Usage"
        title="Requests, tokens, and spend"
        summary={
          usage.isLoading
            ? "Reading usage…"
            : `${formatCount(totals.requests)} requests and ${formatUsd(totals.costUsd)} over the last ${RANGES.find((entry) => entry.id === range)?.label}.`
        }
        actions={
          <Controls>
            {RANGES.map((entry) => (
              <Segment
                key={entry.id}
                type="button"
                $size="sm"
                $on={entry.id === range}
                aria-pressed={entry.id === range}
                onClick={() => setRange(entry.id)}
              >
                {entry.id}
              </Segment>
            ))}
          </Controls>
        }
      />

      <Module
        legend="Breakdown"
        meta={groupLabel?.label}
        actions={
          <Controls>
            {GROUPS.map((entry) => (
              <Segment
                key={entry.id}
                type="button"
                $size="sm"
                $on={entry.id === groupBy}
                aria-pressed={entry.id === groupBy}
                onClick={() => setGroupBy(entry.id)}
              >
                {entry.label}
              </Segment>
            ))}
          </Controls>
        }
      >
        {usage.isError ? (
          <Failure error={usage.error} onRetry={() => void usage.refetch()} />
        ) : usage.isLoading ? (
          <SkeletonRows rows={6} />
        ) : points.length === 0 ? (
          <Empty
            legend="Nothing recorded"
            message="No requests landed in this window. Widen the range, or send traffic through the gateway."
          />
        ) : (
          <Stack $gap={3}>
            <ChartBox>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={points} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                  <CartesianGrid stroke="var(--rule)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "var(--ink-faint)", fontSize: 10 }}
                    stroke="var(--rule-strong)"
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fill: "var(--ink-faint)", fontSize: 10 }}
                    stroke="var(--rule-strong)"
                    width={40}
                  />
                  <Tooltip
                    cursor={{ fill: "var(--accent-wash)" }}
                    content={({ active, payload, label }) => {
                      if (active !== true || payload === undefined || payload.length === 0)
                        return null;
                      const point = payload[0]?.payload as Point | undefined;
                      if (point === undefined) return null;
                      return (
                        <TipCard>
                          <div>{String(label)}</div>
                          <div>{formatCount(point.requests)} requests</div>
                          <div>{formatCount(point.errors)} failed</div>
                          <div>{formatCount(point.tokens)} tokens</div>
                          <div>{formatUsd(point.costUsd)}</div>
                        </TipCard>
                      );
                    }}
                  />
                  {/* Stacked, so a column's height is the request count and the
                      red band is the share of it that failed. Animation is off:
                      the panel re-polls, and a bar that regrows every minute
                      reads as new traffic. */}
                  <Bar
                    dataKey="succeeded"
                    stackId="requests"
                    fill="var(--accent)"
                    fillOpacity={0.85}
                    isAnimationActive={false}
                  />
                  <Bar
                    dataKey="errors"
                    stackId="requests"
                    fill="var(--down)"
                    radius={[2, 2, 0, 0]}
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartBox>

            <ScrollX>
              <Table>
                <thead>
                  <tr>
                    <Th>{groupLabel?.column ?? "Key"}</Th>
                    <Th $align="right">Requests</Th>
                    <Th $align="right">Failed</Th>
                    <Th $align="right">Input</Th>
                    <Th $align="right">Output</Th>
                    <Th $align="right">Cost</Th>
                  </tr>
                </thead>
                <tbody>
                  {ordered.map((bucket) => (
                    <Tr key={bucket.key}>
                      <Td>
                        <Truncate style={{ display: "block", maxWidth: "34ch" }}>
                          {naming(bucket)}
                        </Truncate>
                      </Td>
                      <Td $align="right" $mono>
                        {formatCount(bucket.requests)}
                      </Td>
                      <Td
                        $align="right"
                        $mono
                        style={bucket.errors > 0 ? { color: "var(--down)" } : undefined}
                      >
                        {formatCount(bucket.errors)}
                      </Td>
                      <Td $align="right" $mono>
                        {formatCount(bucket.inputTokens)}
                      </Td>
                      <Td $align="right" $mono>
                        {formatCount(bucket.outputTokens)}
                      </Td>
                      <Td $align="right" $mono>
                        {formatUsd(bucket.costUsd)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
                <tfoot>
                  <Tr>
                    <Td>
                      <Legend>Total</Legend>
                    </Td>
                    <Td $align="right" $mono>
                      {formatCount(totals.requests)}
                    </Td>
                    <Td $align="right" $mono>
                      {formatCount(totals.errors)}
                    </Td>
                    <Td colSpan={2} />
                    <Td $align="right" $mono>
                      {formatUsd(totals.costUsd)}
                    </Td>
                  </Tr>
                </tfoot>
              </Table>
            </ScrollX>
          </Stack>
        )}
      </Module>
    </>
  );
}
