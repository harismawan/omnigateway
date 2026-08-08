import { useMemo, useState } from "react";
import styled from "styled-components";
import type { UsageBucket } from "../../api/types.ts";
import { formatCount, formatUsd } from "../../lib/format.ts";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Mono, Row, ScrollX, Stack } from "../../ui/primitives.ts";
import {
  Controls,
  dayLabel,
  METRICS,
  type MetricId,
  metricOf,
  Segment,
  startOfDay,
  type Totals,
  ZERO_TOTALS,
} from "./shared.ts";

/** 53 columns is what it takes to cover a year once both ends are partial weeks. */
const WEEKS = 53;
const CELL_PX = 9;
const GAP_PX = 2;

const Frame = styled.div`
  display: flex;
  gap: ${GAP_PX}px;
`;

const Weekdays = styled.div`
  display: grid;
  grid-template-rows: repeat(7, ${CELL_PX}px);
  gap: ${GAP_PX}px;
  padding-top: ${CELL_PX + GAP_PX}px;
  font-size: 9px;
  color: ${({ theme }) => theme.color.inkFaint};
`;

const Weekday = styled.div`
  line-height: ${CELL_PX}px;
  padding-right: 2px;
  text-align: right;
`;

const Months = styled.div`
  display: grid;
  grid-template-columns: repeat(${WEEKS}, ${CELL_PX}px);
  gap: ${GAP_PX}px;
  height: ${CELL_PX}px;
  font-size: 9px;
  color: ${({ theme }) => theme.color.inkFaint};
`;

const Month = styled.div`
  white-space: nowrap;
  line-height: ${CELL_PX}px;
`;

const Weeks = styled.div`
  display: grid;
  grid-template-columns: repeat(${WEEKS}, ${CELL_PX}px);
  gap: ${GAP_PX}px;
`;

const Week = styled.div`
  display: grid;
  grid-template-rows: repeat(7, ${CELL_PX}px);
  gap: ${GAP_PX}px;
`;

/**
 * One day. The ramp is a single hue at five steps: magnitude is a sequential
 * quantity, and the console reserves hue itself for provider identity.
 */
const Cell = styled.div<{ $level: number; $future: boolean }>`
  width: ${CELL_PX}px;
  height: ${CELL_PX}px;
  border-radius: 2px;
  background: ${({ $level }) =>
    $level === 0
      ? "var(--panel-sunk)"
      : `color-mix(in oklch, var(--accent) ${[0, 24, 46, 70, 100][$level] ?? 100}%, var(--panel-sunk))`};
  border: 1px solid var(--rule);
  visibility: ${({ $future }) => ($future ? "hidden" : "visible")};

  &:hover,
  &:focus-visible {
    outline: 1px solid var(--ink-dim);
    outline-offset: 1px;
  }
`;

const Scale = styled(Row)`
  gap: ${GAP_PX}px;
`;

const Readout = styled(Mono)`
  color: ${({ theme }) => theme.color.inkDim};
  font-size: 11px;
`;

type Day = { at: number; totals: Totals; future: boolean };

/**
 * Quartiles of the days that saw traffic, so the ramp describes this gateway's
 * own range. A linear scale against the peak turns an ordinary week grey the
 * moment one batch job lands.
 */
function thresholdsOf(values: readonly number[]): [number, number, number] {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (active.length === 0) return [0, 0, 0];
  const at = (fraction: number): number =>
    active[Math.min(active.length - 1, Math.floor(active.length * fraction))] ?? 0;
  return [at(0.25), at(0.5), at(0.75)];
}

function levelOf(value: number, [q1, q2, q3]: readonly [number, number, number]): number {
  if (value <= 0) return 0;
  if (value <= q1) return 1;
  if (value <= q2) return 2;
  if (value <= q3) return 3;
  return 4;
}

export type ActivityGridProps = {
  /** Daily rollup buckets keyed by local midnight. */
  days: readonly UsageBucket[];
  now: number;
};

/**
 * A year of traffic as one square per day, ending on the current week. The
 * grid answers "when was this gateway busy" at a glance; the panels below it
 * answer "on what".
 */
export function ActivityGrid({ days, now }: ActivityGridProps) {
  const [metricId, setMetricId] = useState<MetricId>("tokens");
  const [hovered, setHovered] = useState<Day | null>(null);
  const metric = metricOf(metricId);

  const grid = useMemo<Day[][]>(() => {
    const byDay = new Map<number, Totals>();
    for (const bucket of days) {
      const at = Number(bucket.key);
      if (!Number.isFinite(at)) continue;
      byDay.set(startOfDay(at), {
        requests: bucket.requests,
        errors: bucket.errors,
        costUsd: bucket.costUsd,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cacheReadTokens: bucket.cacheReadTokens,
        cacheWriteTokens: bucket.cacheWriteTokens,
        durationMsSum: bucket.durationMsSum,
      });
    }

    // Columns end on the Saturday of the current week, so today sits in the
    // last column wherever in the week it falls.
    const cursor = new Date(startOfDay(now));
    cursor.setDate(cursor.getDate() + (6 - cursor.getDay()) - (WEEKS * 7 - 1));
    const today = startOfDay(now);

    return Array.from({ length: WEEKS }, () =>
      Array.from({ length: 7 }, (): Day => {
        const at = cursor.getTime();
        cursor.setDate(cursor.getDate() + 1);
        return { at, totals: byDay.get(at) ?? ZERO_TOTALS, future: at > today };
      }),
    );
  }, [days, now]);

  const cells = grid.flat();
  const thresholds = thresholdsOf(cells.map((day) => metric.of({ key: "", ...day.totals })));
  const year = cells.reduce(
    (sum, day) => ({
      requests: sum.requests + day.totals.requests,
      costUsd: sum.costUsd + day.totals.costUsd,
      active: sum.active + (day.totals.requests > 0 ? 1 : 0),
    }),
    { requests: 0, costUsd: 0, active: 0 },
  );

  const describe = (day: Day): string =>
    `${dayLabel(day.at)}: ${formatCount(day.totals.requests)} requests, ` +
    `${formatCount(day.totals.inputTokens + day.totals.outputTokens)} tokens, ` +
    `${formatUsd(day.totals.costUsd)}`;

  return (
    <Module
      legend="Activity"
      meta={
        hovered === null
          ? `${formatCount(year.requests)} requests on ${formatCount(year.active)} active days`
          : undefined
      }
      actions={
        <Controls>
          {METRICS.map((entry) => (
            <Segment
              key={entry.id}
              type="button"
              $size="sm"
              $on={entry.id === metricId}
              aria-pressed={entry.id === metricId}
              onClick={() => setMetricId(entry.id)}
            >
              {entry.label}
            </Segment>
          ))}
        </Controls>
      }
    >
      {/* A year with no traffic still draws its 371 squares: the shape of the
          window is the point, and an empty grid says "nothing yet" by itself. */}
      <Stack $gap={2}>
        <ScrollX>
          <Stack $gap={1} style={{ width: WEEKS * (CELL_PX + GAP_PX) + 28 }}>
            <Frame>
              <Weekdays aria-hidden="true">
                {["", "Mon", "", "Wed", "", "Fri", ""].map((name, index) => (
                  // Static, ordered labels: the index is the row.
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed weekday rows
                  <Weekday key={index}>{name}</Weekday>
                ))}
              </Weekdays>
              <Stack $gap={1}>
                <Months aria-hidden="true">
                  {grid.map((week, index) => {
                    const first = week[0];
                    const previous = grid[index - 1]?.[0];
                    const changed =
                      first !== undefined &&
                      (previous === undefined ||
                        new Date(previous.at).getMonth() !== new Date(first.at).getMonth());
                    return (
                      <Month key={first?.at ?? index}>
                        {changed && first !== undefined
                          ? new Date(first.at).toLocaleDateString("en-GB", { month: "short" })
                          : ""}
                      </Month>
                    );
                  })}
                </Months>
                <Weeks role="grid" aria-label={`${metric.label} per day over the last year`}>
                  {grid.map((week) => (
                    <Week key={week[0]?.at} role="row">
                      {week.map((day) => (
                        <Cell
                          key={day.at}
                          role="gridcell"
                          tabIndex={-1}
                          aria-label={describe(day)}
                          title={describe(day)}
                          $future={day.future}
                          $level={
                            day.future
                              ? 0
                              : levelOf(metric.of({ key: "", ...day.totals }), thresholds)
                          }
                          onMouseEnter={() => setHovered(day)}
                          onMouseLeave={() => setHovered(null)}
                        />
                      ))}
                    </Week>
                  ))}
                </Weeks>
              </Stack>
            </Frame>
          </Stack>
        </ScrollX>

        <Row $justify="space-between" $wrap>
          <Readout>
            {hovered === null ? `Spend ${formatUsd(year.costUsd)}` : describe(hovered)}
          </Readout>
          <Row $gap={1}>
            <Legend>Less</Legend>
            <Scale aria-hidden="true">
              {[0, 1, 2, 3, 4].map((level) => (
                <Cell key={level} $level={level} $future={false} />
              ))}
            </Scale>
            <Legend>More</Legend>
          </Row>
        </Row>
      </Stack>
    </Module>
  );
}
