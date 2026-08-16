import { quotaVerdict } from "@omni/store/types";
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
import { useQuotaHistory } from "../../api/queries.ts";
import type { BurnEstimate, GatewayRate, QuotaSample, QuotaWindow } from "../../api/types.ts";
import { formatClock, formatCount, formatDuration } from "../../lib/format.ts";
import {
  budgetPace,
  burnOf,
  isQuotaStale,
  projectedPace,
  type QuotaPace,
  type QuotaPoint,
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
 * The length comes from the two instants already known — a window that resets
 * at `resetsAt` and began at `windowStartsAt` is that long — so no nominal
 * duration is duplicated here.
 */
function spanStartOf(window: QuotaWindow, estimate: BurnEstimate | undefined): number | null {
  const start = estimate?.windowStartsAt ?? null;
  if (start === null || window.resetsAt === null) return null;
  return start - (window.resetsAt - start);
}

export type QuotaHistoryProps = {
  credentialId: string;
  /** Every window the provider reported for this account, in the order given. */
  windows: readonly QuotaWindow[];
  burn: readonly BurnEstimate[];
  pollIntervalMs: number;
  now: number;
};

/**
 * What one account's quota has been doing, behind the row's disclosure.
 *
 * One request per account rather than per window: the windows share a
 * credential and the samples carry their own `windowType`, so the widest span
 * covers all of them and each panel filters to its own.
 */
export function QuotaHistory({
  credentialId,
  windows,
  burn,
  pollIntervalMs,
  now,
}: QuotaHistoryProps) {
  const panels = windows.map((window) => {
    const estimate = burnOf(burn, window.windowType);
    return { window, estimate, since: spanStartOf(window, estimate) };
  });

  const starts = panels.map((panel) => panel.since).filter((since) => since !== null);
  const since = starts.length === 0 ? 0 : Math.min(...starts);
  // Nothing can be placed on a timeline, so nothing is asked for. Each panel
  // still says why it has no chart.
  const history = useQuotaHistory({ credentialId, since }, starts.length > 0);
  const samples = history.data?.samples ?? [];
  const gatewayRates = history.data?.gatewayRates ?? [];

  return (
    <Stack $gap={4}>
      {panels.map((panel) => (
        <WindowPanel
          key={panel.window.windowType}
          window={panel.window}
          estimate={panel.estimate}
          since={panel.since}
          samples={samples.filter(
            (sample) =>
              sample.windowType === panel.window.windowType &&
              sample.observedAt >= (panel.since ?? 0),
          )}
          gatewayRate={gatewayRates.find((rate) => rate.windowType === panel.window.windowType)}
          pollIntervalMs={pollIntervalMs}
          now={now}
        />
      ))}
    </Stack>
  );
}

type WindowPanelProps = {
  window: QuotaWindow;
  estimate: BurnEstimate | undefined;
  since: number | null;
  samples: readonly QuotaSample[];
  /** Absent until the history request lands, and null when it has no span. */
  gatewayRate: GatewayRate | undefined;
  pollIntervalMs: number;
  now: number;
};

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
function estimateText(window: QuotaWindow, estimate: BurnEstimate, now: number): string {
  const verdict = quotaVerdict(window, estimate);
  if (verdict === "ok") return "lasts the window";
  if (verdict !== "empty" || estimate.exhaustsAt === null) return "unknown";
  if (estimate.exhaustsAt <= now) return "empty now";
  return `empty ~${formatDuration(estimate.exhaustsAt - now)} before it resets`;
}

function WindowPanel({
  window,
  estimate,
  since,
  samples,
  gatewayRate,
  pollIntervalMs,
  now,
}: WindowPanelProps) {
  const label = WINDOW_LABEL[window.windowType];
  const spent =
    window.limit === null
      ? `${formatCount(window.used)} used`
      : `${formatCount(window.used)} of ${formatCount(window.limit)} used`;

  // The same rule the bars and the router use. An estimate derived from a
  // reading nobody believes is worse than no estimate at all.
  if (estimate === undefined || estimate.stale || isQuotaStale(window, now, pollIntervalMs)) {
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
  const segments = withLiveReading(quotaSegments(samples), window);
  // One budget per window drawn, the preceding one included: each is the pace
  // that spends its own allowance exactly as its own window resets.
  const budgets = segments.flatMap((segment) => {
    const pace = budgetPace(segment);
    return pace === null ? [] : [{ key: `${segment.key}-budget`, pace }];
  });
  // One projection, for the window still being spent. The windows before it
  // are settled, and a forecast drawn onto one would be a forecast of the past.
  const projection = projectedPace(window, estimate);
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
  // Room for an overshoot, so a projection past the ceiling reads as one rather
  // than being clipped flat against it. Readings are already capped at a full
  // window, and both ends of the projection are named here because a window
  // read past its own reset projects downward from where it already is.
  const ceiling = Math.max(
    100,
    ...(projection === null
      ? []
      : [projection.from.percent, projection.to.percent].map((percent) => Math.ceil(percent))),
  );

  return (
    <Stack $gap={2}>
      <Row $gap={2} $wrap>
        <Legend>{label} window</Legend>
        <Absent>{spent}</Absent>
      </Row>

      <Facts>
        <Fact>
          <Legend>Window average</Legend>
          <Mono>
            {estimate.ratePerHour === null ? "unknown" : `${formatCount(estimate.ratePerHour)}/h`}
          </Mono>
        </Fact>
        <Fact>
          <Legend>Estimate</Legend>
          <Mono>{estimateText(window, estimate, now)}</Mono>
        </Fact>
        <Fact>
          <Legend>Projected</Legend>
          <Mono>
            {projection === null
              ? "unknown"
              : `${Math.round(projection.to.percent)}% of limit by reset`}
          </Mono>
        </Fact>
        <Fact>
          {/* Provider units and gateway tokens do not convert, so this is a
              second rate beside the first, never a share of it. */}
          <Legend>This gateway accounts for</Legend>
          <Mono>
            {gatewayRate?.gatewayRatePerHour === undefined ||
            gatewayRate.gatewayRatePerHour === null
              ? "unknown"
              : `${formatCount(gatewayRate.gatewayRatePerHour)} tokens/h`}
          </Mono>
        </Fact>
      </Facts>

      {window.limit === null ? (
        <Absent>no ceiling reported</Absent>
      ) : window.resetsAt === null || since === null ? (
        <Absent>no reset reported</Absent>
      ) : segments.length === 0 ? (
        <Absent>not yet observed</Absent>
      ) : (
        <>
          {/* Named because the two overlays cannot be told apart by colour,
              and only where they were actually drawn. */}
          <Legend>
            {[
              "Used, this window and the one before",
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
                  domain={paceDomain(since, window.resetsAt, budgets)}
                  tickFormatter={(at: number) => formatClock(at)}
                  tick={{ fill: "var(--ink-faint)", fontSize: 10 }}
                  stroke="var(--rule-strong)"
                  minTickGap={40}
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
                        <div>{formatClock(at)}</div>
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
