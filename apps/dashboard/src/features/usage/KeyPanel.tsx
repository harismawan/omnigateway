import type { UsageBucket } from "../../api/types.ts";
import { formatCount, formatMs, formatPercent, formatUsd } from "../../lib/format.ts";
import { ScrollX, Truncate } from "../../ui/primitives.ts";
import { Sparkline } from "../../ui/Sparkline.tsx";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";
import {
  addTotals,
  allTokens,
  asBucket,
  keyToTime,
  type Metric,
  type TimeBy,
  type Totals,
  timeTicks,
  ZERO_TOTALS,
} from "./shared.ts";

export type KeyPanelProps = {
  /** Time buckets split by API key. */
  buckets: readonly UsageBucket[];
  by: TimeBy;
  since: number;
  until: number;
  metric: Metric;
  /** Key id to operator-visible label; a revoked key still has rows. */
  names: ReadonlyMap<string, string>;
};

/**
 * Per-key consumption, each row carrying the shape of how it got there. One
 * split query feeds both the totals and the traces, so the traces cannot
 * disagree with the numbers beside them.
 */
export function KeyPanel({ buckets, by, since, until, metric, names }: KeyPanelProps) {
  const ticks = timeTicks(since, until, by);
  const totals = new Map<string, Totals>();
  const traces = new Map<string, Map<number, number>>();

  for (const bucket of buckets) {
    const id = bucket.split ?? "unknown";
    totals.set(id, addTotals(totals.get(id) ?? ZERO_TOTALS, bucket));
    const trace = traces.get(id) ?? new Map<number, number>();
    const at = keyToTime(bucket.key, by);
    trace.set(at, (trace.get(at) ?? 0) + metric.of(bucket));
    traces.set(id, trace);
  }

  const ranked = [...totals.entries()].sort(
    (a, b) => metric.of(asBucket(b[1])) - metric.of(asBucket(a[1])),
  );

  return (
    <ScrollX>
      <Table>
        <thead>
          <tr>
            <Th>Key</Th>
            <Th>Trend</Th>
            <Th $align="right">Requests</Th>
            <Th $align="right">Failed</Th>
            <Th $align="right">Tokens</Th>
            <Th $align="right">Mean</Th>
            <Th $align="right">Cost</Th>
          </tr>
        </thead>
        <tbody>
          {ranked.map(([id, entry]) => {
            const trace = traces.get(id) ?? new Map<number, number>();
            const label = id === "unknown" ? "Unattributed" : (names.get(id) ?? id);
            return (
              <Tr key={id}>
                <Td>
                  <Truncate style={{ display: "block", maxWidth: "28ch" }}>{label}</Truncate>
                </Td>
                <Td style={{ width: 120 }}>
                  <Sparkline
                    values={ticks.map((at) => trace.get(at) ?? 0)}
                    height={20}
                    label={`${label}: ${metric.format(metric.of(asBucket(entry)))} over the window`}
                  />
                </Td>
                <Td $align="right" $mono>
                  {formatCount(entry.requests)}
                </Td>
                <Td
                  $align="right"
                  $mono
                  style={entry.errors > 0 ? { color: "var(--down)" } : undefined}
                >
                  {formatPercent(entry.requests === 0 ? 0 : entry.errors / entry.requests, 0)}
                </Td>
                <Td $align="right" $mono>
                  {formatCount(allTokens(entry))}
                </Td>
                <Td $align="right" $mono>
                  {formatMs(entry.requests === 0 ? null : entry.durationMsSum / entry.requests)}
                </Td>
                <Td $align="right" $mono>
                  {formatUsd(entry.costUsd)}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </ScrollX>
  );
}
