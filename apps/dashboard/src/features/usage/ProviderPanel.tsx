import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { findProvider, useProviderCatalog } from "../../api/queries.ts";
import type { CatalogProvider, UsageBucket } from "../../api/types.ts";
import { formatCount, formatPercent, formatUsd } from "../../lib/format.ts";
import { providerColor } from "../../theme/tokens.ts";
import { Stack } from "../../ui/primitives.ts";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";
import {
  allTokens,
  bySplit,
  ChartBox,
  LegendRow,
  type Metric,
  Swatch,
  splitSeries,
  type TimeBy,
  TipCard,
  type Totals,
  timeLabel,
  timeTicks,
} from "./shared.ts";

/** Anything that never resolved to a provider still has to be countable. */
const UNKNOWN = "unknown";

function colorOf(catalog: readonly CatalogProvider[], name: string): string {
  return findProvider(catalog, name) === undefined ? "var(--ink-faint)" : providerColor(name);
}

function labelOf(catalog: readonly CatalogProvider[], name: string): string {
  return findProvider(catalog, name)?.label ?? "Unresolved";
}

export type ProviderPanelProps = {
  /** Time buckets split by provider. */
  buckets: readonly UsageBucket[];
  by: TimeBy;
  since: number;
  until: number;
  metric: Metric;
};

/**
 * Where the traffic actually went. Hue is doing its one categorical job here —
 * a provider keeps its colour whether or not the others appear in the window.
 */
export function ProviderPanel({ buckets, by, since, until, metric }: ProviderPanelProps) {
  // Loaded before this screen mounts, by the gate in `routes/_app.tsx`.
  const catalog = useProviderCatalog().data ?? [];
  const totals = bySplit(buckets, metric);
  // Fixed order, so a quiet provider dropping out never repaints the rest.
  const ranked = [...catalog.map((provider) => provider.id), UNKNOWN]
    .map((name) => ({ name, totals: totals.get(name) }))
    .filter((entry): entry is { name: string; totals: Totals } => entry.totals !== undefined);
  const names = ranked.map((entry) => entry.name);
  const ticks = timeTicks(since, until, by);
  const rows = splitSeries(buckets, ticks, by, metric);
  const grand = [...totals.values()].reduce((sum, entry) => sum + entry.requests, 0);

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
              // The metric decides the unit, so it decides the tick format too:
              // a token axis in raw digits is unreadable.
              tickFormatter={(value: number) => metric.format(value)}
              tick={{ fill: "var(--ink-faint)", fontSize: 10 }}
              stroke="var(--rule-strong)"
              width={48}
            />
            <Tooltip
              cursor={{ stroke: "var(--rule-strong)" }}
              content={({ active, payload, label }) => {
                if (active !== true || payload === undefined || payload.length === 0) return null;
                return (
                  <TipCard>
                    <div>{timeLabel(Number(label), by)}</div>
                    {payload.map((entry) => (
                      <div key={String(entry.dataKey)}>
                        {labelOf(catalog, String(entry.dataKey))}{" "}
                        {metric.format(Number(entry.value ?? 0))}
                      </div>
                    ))}
                  </TipCard>
                );
              }}
            />
            {names.map((name) => (
              <Area
                key={name}
                type="monotone"
                dataKey={name}
                stackId="providers"
                stroke={colorOf(catalog, name)}
                strokeWidth={2}
                fill={colorOf(catalog, name)}
                fillOpacity={0.22}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </ChartBox>

      <LegendRow>
        {names.map((name) => (
          <span key={name}>
            <Swatch $color={colorOf(catalog, name)} /> {labelOf(catalog, name)}
          </span>
        ))}
      </LegendRow>

      <Table>
        <thead>
          <tr>
            <Th>Provider</Th>
            <Th $align="right">Share</Th>
            <Th $align="right">Requests</Th>
            <Th $align="right">Failed</Th>
            <Th $align="right">Tokens</Th>
            <Th $align="right">Cost</Th>
          </tr>
        </thead>
        <tbody>
          {ranked.map(({ name, totals: entry }) => {
            return (
              <Tr key={name}>
                <Td>
                  <Swatch $color={colorOf(catalog, name)} /> {labelOf(catalog, name)}
                </Td>
                <Td $align="right" $mono>
                  {formatPercent(grand === 0 ? 0 : entry.requests / grand, 0)}
                </Td>
                <Td $align="right" $mono>
                  {formatCount(entry.requests)}
                </Td>
                <Td
                  $align="right"
                  $mono
                  style={entry.errors > 0 ? { color: "var(--down)" } : undefined}
                >
                  {formatCount(entry.errors)}
                </Td>
                <Td $align="right" $mono>
                  {formatCount(allTokens(entry))}
                </Td>
                <Td $align="right" $mono>
                  {formatUsd(entry.costUsd)}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </Stack>
  );
}
