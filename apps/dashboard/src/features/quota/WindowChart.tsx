import { durationFor, quotaVerdict } from "@omni/store/types";
import type { ReactNode } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import styled from "styled-components";
import { formatChartTime, formatDateTime, formatDuration, isDatedSpan } from "../../lib/format.ts";
import {
  budgetPace,
  projectedPace,
  type QuotaPace,
  type QuotaPoint,
  type QuotaReading,
  quotaSegments,
  WINDOW_LABEL,
  withLiveReading,
} from "../../lib/vitals.ts";
import { Legend, Mono, Row, Stack } from "../../ui/primitives.ts";
import { ChartBox, TipCard } from "../usage/shared.ts";

const Facts = styled(Row)`
  gap: ${({ theme }) => theme.space(5)};
  flex-wrap: wrap;
`;

const Fact = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

/** A state the provider left unreported, said in words rather than left blank. */
const Absent = styled.span`
  font-size: 11.5px;
  color: ${({ theme }) => theme.color.inkDim};
`;

/**
 * How the two pace lines are told apart.
 *
 * By dash rather than by hue: colour on this console means provider identity or
 * state, and neither of these is either. Dashed also reads as inferred rather
 * than measured, which is exactly what separates a projection from the solid
 * line of readings underneath it.
 */
export const PACE_DASH = { budget: "1 4", projection: "6 4" } as const;

/** The series the projection is drawn as. One per panel, never per window. */
const PROJECTION_KEY = "projected";

type BudgetSeries = { key: string; pace: QuotaPace };

/** A chart row is one instant and whatever each series had to say at it. */
type PanelRow = { at: number; [series: string]: number };

/**
 * One row per instant, so a pace endpoint landing on a reading shares its row
 * rather than sitting beside it as a second point at the same x.
 *
 * Series are sparse by construction: a row carries the one key it came from, so
 * every other series reads null at that instant. Nothing here keeps a run
 * contiguous in row space — a budget's endpoint sits at its own `resetsAt`,
 * which lands inside the measured run whenever the window was read after the
 * reset it stated — so the lines drawn from these rows connect across nulls
 * rather than breaking on them, and the window split is carried by the per-run
 * `dataKey` instead.
 */
function chartRows(
  series: ReadonlyArray<{ key: string; points: readonly QuotaPoint[] }>,
): PanelRow[] {
  const rows = new Map<number, PanelRow>();
  for (const { key, points } of series) {
    for (const point of points) {
      const row = rows.get(point.at) ?? { at: point.at };
      row[key] = point.percent;
      rows.set(point.at, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.at - b.at);
}

/**
 * The span the chart covers.
 *
 * The requested span, widened to whatever a pace reaches past it. A preceding
 * window that ran longer than this one begins before the span was asked for,
 * and its budget would otherwise be drawn outside the plot.
 */
function paceDomain(
  since: number,
  resetsAt: number,
  budgets: readonly BudgetSeries[],
): [number, number] {
  return [
    Math.min(since, ...budgets.map((budget) => budget.pace.from.at)),
    Math.max(resetsAt, ...budgets.map((budget) => budget.pace.to.at)),
  ];
}

/**
 * The span a window is charted over: itself, plus the one before it.
 *
 * Derived from the reading alone — a window resetting at `resetsAt` and lasting
 * `durationFor` began that long before it — so both surfaces ask for the same
 * span without one of them needing an estimate the other is never sent.
 */
export function chartSpanOf(live: QuotaReading): number | null {
  if (live.resetsAt === null) return null;
  const start = live.resetsAt - durationFor(live.windowType, live.windowMs);
  return start - (live.resetsAt - start);
}

/**
 * What the projection reached, phrased against where it stopped.
 *
 * `projectedPace` truncates at the ceiling, so a pace that would have overshot
 * ends at 100% at its crossing instant rather than above it at the reset. "By
 * reset" would then be untrue in the one case it most matters: the window is
 * full before the reset arrives, which is the opposite of what that reads as.
 */
function projectedText(resetsAt: number | null, projection: QuotaPace | null): string {
  if (projection === null) return "unknown";
  if (resetsAt !== null && projection.to.at < resetsAt) {
    return "100% of limit before it resets";
  }
  return `${Math.round(projection.to.percent)}% of limit by reset`;
}

/**
 * How the exhaustion estimate reads, always phrased against the reset.
 *
 * The verdict comes from `@omni/store/types` rather than from `survives`
 * directly, and `omni quota` phrases from the same call. `survives` is true by
 * construction whenever there is no `exhaustsAt` — which includes a window with
 * no ceiling and one with no inferable rate — so branching on it first prints
 * "lasts the window" beside a panel that is simultaneously reporting that
 * nothing is known.
 */
function estimateText(props: WindowChartProps, now: number): string {
  const verdict = quotaVerdict(
    // In ratio space the ceiling is exactly one, which is what lets a client —
    // told a fraction and never a ceiling — reach the same verdict the operator
    // does through the one function that owns it.
    { observedAt: props.live.observedAt, limit: props.live.usedRatio === null ? null : 1 },
    {
      ratePerHour: props.ratePerHourRatio,
      exhaustsAt: props.exhaustsAt,
      survives: props.survives,
      stale: props.stale || props.rolledOver,
    },
  );
  if (verdict === "ok") return "lasts the window";
  if (verdict !== "empty" || props.exhaustsAt === null) return "unknown";
  if (props.exhaustsAt <= now) return "empty now";
  return `empty ~${formatDuration(props.exhaustsAt - now)} before it resets`;
}

export type WindowChartProps = {
  /** The live reading, as a fraction of its own ceiling. */
  live: QuotaReading;
  /** The retained readings for this window and the one before it. */
  samples: readonly QuotaReading[];
  /** Where the plot starts, or null when nothing can be placed on a timeline. */
  since: number | null;
  now: number;
  /** How fast the window is going, as a fraction of its ceiling per hour. */
  ratePerHourRatio: number | null;
  exhaustsAt: number | null;
  survives: boolean | null;
  /**
   * True when the reading must not be drawn from at all: the panel says so
   * instead of charting. Each surface decides it, because the two learn it
   * differently — the console ages the snapshot itself, and a client is told.
   */
  stale: boolean;
  /**
   * True when the reading counts a window whose reset has passed.
   *
   * Not a kind of staleness: such a reading is minutes old, so the chart is
   * still drawn and the measured history stays. Only the inferences below go,
   * with a note saying which of the two happened.
   */
  rolledOver: boolean;
  /** What the live reading says, in the surface's own vocabulary. */
  spent: string;
  /** The window-average rate, in the surface's own units. */
  rateText: string;
  /** A further fact after the shared three, where a surface has one. */
  extraFact?: ReactNode;
  /**
   * True when the readings were capped, so the series starts later than the
   * axis it is drawn against. Said in the legend rather than left to the eye.
   */
  truncated?: boolean;
};

/**
 * One quota window: what it has spent, what that implies, and the readings
 * behind both.
 *
 * Shared by the operator's account disclosure and the client's provider
 * headroom panel. Everything drawn here is a percentage of the window, so the
 * two surfaces differ only in the units they *say* — provider counts against a
 * ceiling for the operator, a bare percentage for a client, who is told the
 * fraction precisely so the size of the operator's account stays unstated.
 */
export function WindowChart(props: WindowChartProps) {
  const { live, samples, since, now, stale, rolledOver, spent, truncated = false } = props;
  const label = WINDOW_LABEL[live.windowType];

  // An estimate derived from a reading nobody believes is worse than no
  // estimate at all. A rolled-over window is not that case and is not blanked:
  // its retained readings were measured and stay measured, so the chart is
  // drawn and every derived figure below reads "unknown" on its own.
  if (stale) {
    return (
      <Stack $gap={2}>
        <Row $gap={2} $wrap>
          <Legend>{label} window</Legend>
          <Absent>{spent}</Absent>
        </Row>
        <Absent>reading is stale</Absent>
      </Stack>
    );
  }

  // The snapshot's own reading, on the run it belongs to. Everything below is
  // derived from this list, so it happens before any of it.
  const segments = withLiveReading(quotaSegments(samples), live);
  // One budget per window drawn, the preceding one included: each is the pace
  // that spends its own allowance exactly as its own window resets.
  const budgets = segments.flatMap((segment) => {
    const pace = budgetPace(segment);
    return pace === null ? [] : [{ key: `${segment.key}-budget`, pace }];
  });
  // One projection, for the window still being spent. The windows before it
  // are settled, and a forecast drawn onto one would be a forecast of the past.
  const projection = projectedPace(live, props.ratePerHourRatio);
  const rows = chartRows([
    ...segments,
    ...budgets.map((budget) => ({ key: budget.key, points: [budget.pace.from, budget.pace.to] })),
    ...(projection === null
      ? []
      : [{ key: PROJECTION_KEY, points: [projection.from, projection.to] }]),
  ]);
  // Only a measured reading gets a tooltip; the pace lines are figures the
  // facts row already states in words.
  const measured = new Set(segments.map((segment) => segment.key));
  // A full window and no further. Readings are capped at one, budgets end at
  // one, and `projectedPace` truncates at the instant it reaches one — so
  // nothing drawn here can exceed it. Scaling to an overshoot instead is what
  // this used to do, and in the minutes after a rollover the whole-window
  // average is large enough to put the axis in the thousands of percent and
  // flatten every measured reading onto the floor.
  const ceiling = 100;
  // Computed once, because the axis is labelled by how much time it covers as
  // well as bounded by it: a span wider than a day gets dated ticks, and dated
  // ticks are wide enough to need a wider gap kept between them.
  const domain =
    since === null || live.resetsAt === null ? null : paceDomain(since, live.resetsAt, budgets);

  return (
    <Stack $gap={2}>
      <Row $gap={2} $wrap>
        <Legend>{label} window</Legend>
        <Absent>{spent}</Absent>
        {/* Said beside the reading it qualifies, because that reading is the
            spent window's and the figures below are all "unknown" without it
            saying why. */}
        {rolledOver ? <Absent>· rolled over, waiting for the next reading</Absent> : null}
      </Row>

      <Facts>
        <Fact>
          <Legend>Window average</Legend>
          <Mono>{props.rateText}</Mono>
        </Fact>
        <Fact>
          <Legend>Estimate</Legend>
          <Mono>{estimateText(props, now)}</Mono>
        </Fact>
        <Fact>
          <Legend>Projected</Legend>
          <Mono>{projectedText(live.resetsAt, projection)}</Mono>
        </Fact>
        {props.extraFact}
      </Facts>

      {live.usedRatio === null ? (
        <Absent>no ceiling reported</Absent>
      ) : domain === null ? (
        <Absent>no reset reported</Absent>
      ) : segments.length === 0 ? (
        <Absent>not yet observed</Absent>
      ) : (
        <>
          {/* Named because the two overlays cannot be told apart by colour,
              and only where they were actually drawn.

              The truncation note is here rather than left to the eye: the axis
              is stated from the span asked for, so a series that starts late
              draws exactly like a gateway that was not recording — the one
              reading a client must not be given by accident. */}
          <Legend>
            {[
              "Used, this window and the one before",
              ...(truncated ? ["earliest readings not shown"] : []),
              ...(budgets.length === 0 ? [] : ["budget dotted"]),
              ...(projection === null ? [] : ["projection dashed"]),
            ].join(" · ")}
          </Legend>
          <ChartBox $height={160}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 4, left: 4 }}>
                <CartesianGrid stroke="var(--rule)" vertical={false} />
                <XAxis
                  dataKey="at"
                  type="number"
                  scale="time"
                  domain={domain}
                  tickFormatter={(at: number) => formatChartTime(at, domain[1] - domain[0])}
                  tick={{ fill: "var(--ink-faint)", fontSize: 10 }}
                  stroke="var(--rule-strong)"
                  minTickGap={isDatedSpan(domain[1] - domain[0]) ? 80 : 40}
                />
                {/* The scale is stated, not inferred. Left to itself recharts
                    stretches a numeric domain to whatever the data reached, so
                    the axis would be describing the samples rather than the
                    window, and nothing would hold it to a full window when the
                    readings stay well below one. */}
                <YAxis
                  domain={[0, ceiling]}
                  allowDataOverflow
                  tickFormatter={(percent: number) => `${Math.round(percent)}%`}
                  tick={{ fill: "var(--ink-faint)", fontSize: 10 }}
                  stroke="var(--rule-strong)"
                  width={40}
                />
                <Tooltip
                  cursor={{ stroke: "var(--rule-strong)" }}
                  content={({ active, payload }) => {
                    if (active !== true || payload === undefined || payload.length === 0) {
                      return null;
                    }
                    const point = payload.find((entry) => measured.has(String(entry.dataKey)));
                    if (point === undefined || typeof point.value !== "number") return null;
                    const at = (point.payload as { at: number }).at;
                    return (
                      <TipCard>
                        {/* Dated unconditionally, unlike the ticks: a tooltip
                            is asked for one point at a time and has the room,
                            so there is nothing to buy by leaving it ambiguous
                            on the panels whose axis happens to fit in a day. */}
                        <div>{formatDateTime(at)}</div>
                        <div>{point.value.toFixed(1)}% used</div>
                      </TipCard>
                    );
                  }}
                />
                {/* One series per window. A single series drawn across a
                    rollover would fall to the floor and read as a refund.
                    `monotone`, as the usage panels draw theirs: a quota counter
                    climbs as requests land, not in one jump at the instant it
                    happened to be read, and monotone cubic will not overshoot a
                    reading on the way to the next.

                    What the curve does between two readings is drawing, not
                    evidence. A step claimed no more: dedup drops the unchanged
                    reading that would have made a flat stretch provable, so an
                    interior gap cannot be read as "probed, and nothing moved".
                    The trailing stretch is the exception and is the one the
                    snapshot buys: `withLiveReading` ends the run at a reading
                    that was actually taken, so that last stretch is flat
                    because the account was read and had not moved.

                    `connectNulls` because the window split is carried by the
                    per-run `dataKey`, not by the nulls: `chartRows` writes a
                    run's key at that run's own instants and nowhere else, so
                    the only values this line can reach are its own and a null
                    means "some other series had something to say at this
                    instant", never "this run stopped". Breaking on them
                    silently assumed runs were contiguous in row space, which a
                    budget endpoint at `resetsAt` makes untrue the moment a
                    window is read past its own reset. */}
                {segments.map((segment) => (
                  <Line
                    key={segment.key}
                    type="monotone"
                    dataKey={segment.key}
                    stroke="var(--accent)"
                    strokeWidth={2}
                    dot={
                      // A run of one reading draws no stroke — a line needs two
                      // points to be a line — so it is marked instead, in the
                      // stroke's own colour rather than a second one.
                      segment.points.length === 1
                        ? { r: 2.5, fill: "var(--accent)", stroke: "var(--accent)" }
                        : false
                    }
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
                {/* Two ends and nothing between them, so each pace connects
                    across the readings it is drawn over rather than breaking
                    on every instant it has no value for. */}
                {budgets.map((budget) => (
                  <Line
                    key={budget.key}
                    type="linear"
                    dataKey={budget.key}
                    stroke="var(--ink-faint)"
                    strokeWidth={1.5}
                    strokeDasharray={PACE_DASH.budget}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
                {projection === null ? null : (
                  <Line
                    type="linear"
                    dataKey={PROJECTION_KEY}
                    stroke="var(--ink-dim)"
                    strokeWidth={1.5}
                    strokeDasharray={PACE_DASH.projection}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </ChartBox>
        </>
      )}
    </Stack>
  );
}

/** The fourth fact, for a surface that has one. */
export function ExtraFact({ legend, value }: { legend: string; value: string }) {
  return (
    <Fact>
      <Legend>{legend}</Legend>
      <Mono>{value}</Mono>
    </Fact>
  );
}
