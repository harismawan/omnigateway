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
import { burnOf, isQuotaStale, quotaSegments, WINDOW_LABEL } from "../../lib/vitals.ts";
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

  const segments = quotaSegments(samples);
  const rows = segments
    .flatMap((segment) =>
      segment.points.map((point) => ({ at: point.at, [segment.key]: point.percent })),
    )
    .sort((a, b) => a.at - b.at);

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
          <Legend>Used, this window and the one before</Legend>
          <ChartBox $height={160}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 4, left: 4 }}>
                <CartesianGrid stroke="var(--rule)" vertical={false} />
                <XAxis
                  dataKey="at"
                  type="number"
                  scale="time"
                  domain={[since, window.resetsAt]}
                  tickFormatter={(at: number) => formatClock(at)}
                  tick={{ fill: "var(--ink-faint)", fontSize: 10 }}
                  stroke="var(--rule-strong)"
                  minTickGap={40}
                />
                <YAxis
                  domain={[0, 100]}
                  tickFormatter={(percent: number) => `${percent}%`}
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
                    const point = payload[0];
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
                    `stepAfter` because a reading holds until the next one:
                    interpolating would draw a climb that never happened. */}
                {segments.map((segment) => (
                  <Line
                    key={segment.key}
                    type="stepAfter"
                    dataKey={segment.key}
                    stroke="var(--accent)"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </ChartBox>
        </>
      )}
    </Stack>
  );
}
