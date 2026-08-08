import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { UsageBucket } from "../../api/types.ts";
import { formatCount, formatPercent } from "../../lib/format.ts";
import { Mono, Row, Stack } from "../../ui/primitives.ts";
import {
  ChartBox,
  keyToTime,
  LegendRow,
  Swatch,
  type TimeBy,
  TipCard,
  timeLabel,
  timeTicks,
} from "./shared.ts";

/**
 * The four token classes, in billing order. They are steps of one hue rather
 * than four colours: this is a composition of one quantity, and the console
 * spends hue only on provider identity.
 */
const CLASSES = [
  { id: "inputTokens", label: "Input", opacity: 0.95 },
  { id: "outputTokens", label: "Output", opacity: 0.7 },
  { id: "cacheReadTokens", label: "Cache read", opacity: 0.45 },
  { id: "cacheWriteTokens", label: "Cache write", opacity: 0.22 },
] as const satisfies ReadonlyArray<{
  id: keyof Pick<
    UsageBucket,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
  >;
  label: string;
  opacity: number;
}>;

export type TokenMixPanelProps = {
  buckets: readonly UsageBucket[];
  by: TimeBy;
  since: number;
  until: number;
};

/**
 * Where the tokens went. Cache reads are the cheap ones, so a window whose
 * cache band is thin is a window that is paying full price for context it
 * already sent.
 */
export function TokenMixPanel({ buckets, by, since, until }: TokenMixPanelProps) {
  const byTick = new Map<number, UsageBucket>();
  for (const bucket of buckets) byTick.set(keyToTime(bucket.key, by), bucket);

  const rows = timeTicks(since, until, by).map((at) => {
    const bucket = byTick.get(at);
    return {
      at,
      inputTokens: bucket?.inputTokens ?? 0,
      outputTokens: bucket?.outputTokens ?? 0,
      cacheReadTokens: bucket?.cacheReadTokens ?? 0,
      cacheWriteTokens: bucket?.cacheWriteTokens ?? 0,
    };
  });

  const totals = CLASSES.map((entry) => ({
    ...entry,
    value: rows.reduce((sum, row) => sum + row[entry.id], 0),
  }));
  const grand = totals.reduce((sum, entry) => sum + entry.value, 0);

  return (
    <Stack $gap={3}>
      <ChartBox $height={200}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--rule)" vertical={false} />
            <XAxis
              dataKey="at"
              tickFormatter={(at: number) => timeLabel(at, by)}
              tick={{ fill: "var(--ink-faint)", fontSize: 10 }}
              stroke="var(--rule-strong)"
              interval="preserveStartEnd"
              minTickGap={28}
            />
            <YAxis
              tick={{ fill: "var(--ink-faint)", fontSize: 10 }}
              stroke="var(--rule-strong)"
              width={44}
              tickFormatter={(value: number) => formatCount(value)}
            />
            <Tooltip
              cursor={{ stroke: "var(--rule-strong)" }}
              content={({ active, payload, label }) => {
                if (active !== true || payload === undefined || payload.length === 0) return null;
                return (
                  <TipCard>
                    <div>{timeLabel(Number(label), by)}</div>
                    {CLASSES.map((entry) => (
                      <div key={entry.id}>
                        {entry.label}{" "}
                        {formatCount(
                          Number(payload.find((row) => row.dataKey === entry.id)?.value ?? 0),
                        )}
                      </div>
                    ))}
                  </TipCard>
                );
              }}
            />
            {CLASSES.map((entry) => (
              <Area
                key={entry.id}
                type="monotone"
                dataKey={entry.id}
                stackId="tokens"
                stroke="var(--accent)"
                strokeOpacity={entry.opacity}
                strokeWidth={1.5}
                fill="var(--accent)"
                fillOpacity={entry.opacity * 0.5}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </ChartBox>

      <LegendRow>
        {totals.map((entry) => (
          <Row key={entry.id} $gap={1}>
            <Swatch $color="var(--accent)" style={{ opacity: entry.opacity }} />
            <span>{entry.label}</span>
            <Mono $size="11px">{formatCount(entry.value)}</Mono>
            <Mono $size="11px" $dim>
              {formatPercent(grand === 0 ? 0 : entry.value / grand, 0)}
            </Mono>
          </Row>
        ))}
      </LegendRow>
    </Stack>
  );
}
