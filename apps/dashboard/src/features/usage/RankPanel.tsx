import styled from "styled-components";
import type { UsageBucket } from "../../api/types.ts";
import { formatCount, formatUsd } from "../../lib/format.ts";
import { Mono, Row, Stack, Truncate } from "../../ui/primitives.ts";
import { addTotals, asBucket, type Metric, type Totals, ZERO_TOTALS } from "./shared.ts";

const Rank = styled.li`
  display: grid;
  grid-template-columns: minmax(0, 20ch) 1fr auto;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
`;

const List = styled.ol`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space(2)};
`;

const Track = styled.div`
  height: 8px;
  border-radius: 2px;
  background: ${({ theme }) => theme.color.panelSunk};
  border: 1px solid ${({ theme }) => theme.color.rule};
  overflow: hidden;
`;

/**
 * The bar is anchored to the left rule and ends in a rounded cap, so a short
 * bar still reads as a measured quantity rather than as a stub.
 */
const Fill = styled.div<{ $share: number; $fault: boolean }>`
  width: ${({ $share }) => `${Math.max(1.5, $share * 100)}%`};
  height: 100%;
  border-radius: 0 2px 2px 0;
  background: ${({ theme, $fault }) => ($fault ? theme.color.down : theme.color.accent)};
  opacity: 0.85;
`;

const Name = styled(Truncate)`
  display: block;
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
`;

/** Beyond this the ranking stops being a ranking and becomes a list. */
const SHOWN = 12;

export type RankPanelProps = {
  buckets: readonly UsageBucket[];
  metric: Metric;
  /** Maps opaque ids to operator-visible labels; a raw id passes through. */
  names?: ReadonlyMap<string, string>;
  /** Shown for a bucket the gateway could not attribute. */
  unknownLabel?: string;
};

/**
 * A ranking rather than a chart with axes: the question is which models — or
 * accounts — carry the traffic, and the answer is an order plus a magnitude. A
 * row whose whole volume failed is drawn in the fault colour, because a tall
 * bar of errors is not the same news as a tall bar of work.
 */
export function RankPanel({ buckets, metric, names, unknownLabel }: RankPanelProps) {
  const totals = new Map<string, Totals>();
  for (const bucket of buckets) {
    totals.set(bucket.key, addTotals(totals.get(bucket.key) ?? ZERO_TOTALS, bucket));
  }

  const label = (id: string): string =>
    id === "unknown" ? (unknownLabel ?? "Unattributed") : (names?.get(id) ?? id);

  const ranked = [...totals.entries()]
    .map(([id, entry]) => ({ name: label(id), entry, value: metric.of(asBucket(entry)) }))
    .sort((a, b) => b.value - a.value);
  const shown = ranked.slice(0, SHOWN);
  const rest = ranked.slice(SHOWN);
  const top = shown[0]?.value ?? 0;

  return (
    <Stack $gap={3}>
      <List>
        {shown.map(({ name, entry, value }) => (
          <Rank key={name}>
            <Name title={name}>{name}</Name>
            <Track>
              <Fill
                $share={top === 0 ? 0 : value / top}
                $fault={entry.requests > 0 && entry.errors === entry.requests}
              />
            </Track>
            <Row $gap={2}>
              <Mono $size="12px">{metric.format(value)}</Mono>
              <Mono $size="11px" $dim>
                {formatUsd(entry.costUsd)}
              </Mono>
            </Row>
          </Rank>
        ))}
      </List>
      {rest.length === 0 ? null : (
        <Mono $size="11px" $dim>
          {`+ ${rest.length} more, ${formatCount(rest.reduce((sum, entry) => sum + entry.entry.requests, 0))} requests`}
        </Mono>
      )}
    </Stack>
  );
}
