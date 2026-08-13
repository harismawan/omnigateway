import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { UsageBucket } from "../../api/types.ts";
import { formatCount, formatUsd } from "../../lib/format.ts";
import { Stack } from "../../ui/primitives.ts";
import {
  allTokens,
  ChartBox,
  keyToTime,
  LegendRow,
  Swatch,
  type TimeBy,
  TipCard,
  timeLabel,
  timeTicks,
} from "./shared.ts";

type Point = {
  at: number;
  label: string;
  requests: number;
  errors: number;
  costUsd: number;
  tokens: number;
};

export type TrafficPanelProps = {
  buckets: readonly UsageBucket[];
  by: TimeBy;
  since: number;
  until: number;
};

/**
 * Traffic over the window as two traces on one axis: total requests, and the
 * failed subset of them in the fault colour. Both share a scale — a second
 * axis for the small series would make two failures look like a spike.
 * Empty ticks are kept: a gap in traffic is information.
 */
export function TrafficPanel({ buckets, by, since, until }: TrafficPanelProps) {
  const byTick = new Map<number, UsageBucket>();
  for (const bucket of buckets) byTick.set(keyToTime(bucket.key, by), bucket);

  const points: Point[] = timeTicks(since, until, by).map((at) => {
    const bucket = byTick.get(at);
    return {
      at,
      label: timeLabel(at, by),
      requests: bucket?.requests ?? 0,
      errors: bucket?.errors ?? 0,
      costUsd: bucket?.costUsd ?? 0,
      tokens: bucket === undefined ? 0 : allTokens(bucket),
    };
  });

  return (
    <Stack $gap={2}>
      <ChartBox $height={220}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--rule)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: "var(--ink-faint)", fontSize: 10 }}
              stroke="var(--rule-strong)"
              interval="preserveStartEnd"
              minTickGap={28}
            />
            <YAxis
              tick={{ fill: "var(--ink-faint)", fontSize: 10 }}
              stroke="var(--rule-strong)"
              width={40}
            />
            <Tooltip
              cursor={{ stroke: "var(--rule-strong)" }}
              content={({ active, payload }) => {
                if (active !== true || payload === undefined || payload.length === 0) return null;
                const point = payload[0]?.payload as Point | undefined;
                if (point === undefined) return null;
                return (
                  <TipCard>
                    <div>{point.label}</div>
                    <div>{formatCount(point.requests)} requests</div>
                    <div>{formatCount(point.errors)} failed</div>
                    <div>{formatCount(point.tokens)} tokens</div>
                    <div>{formatUsd(point.costUsd)}</div>
                  </TipCard>
                );
              }}
            />
            {/* A wash under the traffic trace so the line reads as a volume,
                not as a value that could go negative. Animation is off: the
                panel re-polls, and a line that redraws every minute reads as
                new traffic. */}
            <Area
              type="monotone"
              dataKey="requests"
              stroke="none"
              fill="var(--accent)"
              fillOpacity={0.12}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="requests"
              stroke="var(--accent)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: "var(--panel)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="errors"
              stroke="var(--down)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: "var(--panel)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartBox>
      <LegendRow>
        <span>
          <Swatch $color="var(--accent)" /> Requests
        </span>
        <span>
          <Swatch $color="var(--down)" /> Failed
        </span>
      </LegendRow>
    </Stack>
  );
}
