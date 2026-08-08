import styled from "styled-components";
import type { UsageBucket, UsageDimension, UsageGrain } from "../../api/types.ts";
import { formatCount, formatUsd } from "../../lib/format.ts";
import { Button } from "../../ui/Button.tsx";
import { Row } from "../../ui/primitives.ts";

/**
 * A window, and the grain that can answer it. Anything inside the log
 * retention window is read from the raw logs so it can resolve to the hour;
 * anything longer comes from the daily rollup, which is the only thing that
 * still exists that far back.
 */
export const RANGES = [
  { id: "1h", label: "1 hour", ms: 3_600_000, grain: "raw", by: "hour" },
  { id: "24h", label: "24 hours", ms: 86_400_000, grain: "raw", by: "hour" },
  { id: "7d", label: "7 days", ms: 604_800_000, grain: "raw", by: "hour" },
  { id: "30d", label: "30 days", ms: 2_592_000_000, grain: "raw", by: "hour" },
  { id: "90d", label: "90 days", ms: 7_776_000_000, grain: "daily", by: "day" },
  { id: "1y", label: "12 months", ms: 31_536_000_000, grain: "daily", by: "day" },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  ms: number;
  grain: UsageGrain;
  by: UsageDimension & ("hour" | "day");
}>;

export type RangeId = (typeof RANGES)[number]["id"];
export type Range = (typeof RANGES)[number];
export type TimeBy = Range["by"];

export function rangeOf(id: RangeId): Range {
  return RANGES.find((entry) => entry.id === id) ?? RANGES[1];
}

/** The activity grid always asks for a year and a bit, whatever the range is. */
export const ACTIVITY_DAYS = 371;

export type MetricId = "requests" | "tokens" | "cost";

/**
 * The three lenses every panel can be read through. `tokens` stays at
 * input + output — the two the operator is charged for per request — while the
 * token-mix panel is where cache traffic gets its own reading.
 */
export const METRICS = [
  {
    id: "requests",
    label: "Requests",
    of: (bucket: UsageBucket) => bucket.requests,
    format: formatCount,
  },
  {
    id: "tokens",
    label: "Tokens",
    of: (bucket: UsageBucket) => bucket.inputTokens + bucket.outputTokens,
    format: formatCount,
  },
  { id: "cost", label: "Cost", of: (bucket: UsageBucket) => bucket.costUsd, format: formatUsd },
] as const satisfies ReadonlyArray<{
  id: MetricId;
  label: string;
  of: (bucket: UsageBucket) => number;
  format: (value: number) => string;
}>;

export type Metric = (typeof METRICS)[number];

export function metricOf(id: MetricId): Metric {
  return METRICS.find((entry) => entry.id === id) ?? METRICS[0];
}

const HOUR_MS = 3_600_000;

/** Bucket keys are hour indices at the raw grain and local midnights at the daily one. */
export function keyToTime(key: string, by: TimeBy): number {
  const value = Number(key);
  if (!Number.isFinite(value)) return Number.NaN;
  return by === "hour" ? value * HOUR_MS : value;
}

export function timeToKey(at: number, by: TimeBy): string {
  return by === "hour" ? String(Math.floor(at / HOUR_MS)) : String(startOfDay(at));
}

export function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * Every tick in the window, including the empty ones. A gap has to be drawn as
 * zero traffic rather than closed up, or a quiet weekend reads as a busy one.
 * Days are stepped through the calendar so a DST change stays one tick.
 */
export function timeTicks(since: number, until: number, by: TimeBy): number[] {
  const ticks: number[] = [];
  if (by === "hour") {
    const first = Math.floor(since / HOUR_MS) * HOUR_MS;
    for (let at = first; at <= until; at += HOUR_MS) ticks.push(at);
    return ticks;
  }
  const cursor = new Date(startOfDay(since));
  while (cursor.getTime() <= until) {
    ticks.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  return ticks;
}

export function timeLabel(at: number, by: TimeBy): string {
  if (!Number.isFinite(at)) return "—";
  return new Date(at).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    ...(by === "hour" ? { hour: "2-digit", hour12: false } : { year: "2-digit" }),
  });
}

export function dayLabel(at: number): string {
  return new Date(at).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export type Totals = {
  requests: number;
  errors: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMsSum: number;
};

export const ZERO_TOTALS: Totals = {
  requests: 0,
  errors: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  durationMsSum: 0,
};

export function addTotals(sum: Totals, bucket: UsageBucket): Totals {
  return {
    requests: sum.requests + bucket.requests,
    errors: sum.errors + bucket.errors,
    costUsd: sum.costUsd + bucket.costUsd,
    inputTokens: sum.inputTokens + bucket.inputTokens,
    outputTokens: sum.outputTokens + bucket.outputTokens,
    cacheReadTokens: sum.cacheReadTokens + bucket.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + bucket.cacheWriteTokens,
    durationMsSum: sum.durationMsSum + bucket.durationMsSum,
  };
}

export function totalsOf(buckets: readonly UsageBucket[]): Totals {
  return buckets.reduce(addTotals, ZERO_TOTALS);
}

/**
 * Folds split buckets into one entry per `split` value, ordered by the metric.
 * This is what lets a single split query feed both a ranking and its traces.
 */
export function bySplit(buckets: readonly UsageBucket[], metric: Metric): Map<string, Totals> {
  const totals = new Map<string, Totals>();
  for (const bucket of buckets) {
    const name = bucket.split ?? bucket.key;
    totals.set(name, addTotals(totals.get(name) ?? ZERO_TOTALS, bucket));
  }
  return new Map(
    [...totals.entries()].sort((a, b) => metric.of(asBucket(b[1])) - metric.of(asBucket(a[1]))),
  );
}

/** Totals carry every measure a bucket does, so a metric reads either shape. */
export function asBucket(totals: Totals): UsageBucket {
  return { key: "", ...totals };
}

/**
 * A dense series per split value: one number per tick, zero-filled. Recharts
 * wants row objects, so the caller gets `{ at, [name]: value }` rows.
 */
export function splitSeries(
  buckets: readonly UsageBucket[],
  ticks: readonly number[],
  by: TimeBy,
  metric: Metric,
): Array<Record<string, number>> {
  const cells = new Map<string, number>();
  for (const bucket of buckets) {
    const at = keyToTime(bucket.key, by);
    const id = `${at} ${bucket.split ?? "unknown"}`;
    cells.set(id, (cells.get(id) ?? 0) + metric.of(bucket));
  }
  const names = new Set(buckets.map((bucket) => bucket.split ?? "unknown"));
  return ticks.map((at) => {
    const row: Record<string, number> = { at };
    for (const name of names) row[name] = cells.get(`${at} ${name}`) ?? 0;
    return row;
  });
}

/** A pressed-state control. Buttons rather than a select: the state is visible. */
export const Segment = styled(Button)<{ $on: boolean }>`
  border-color: ${({ theme, $on }) => ($on ? theme.color.accent : theme.color.ruleStrong)};
  color: ${({ theme, $on }) => ($on ? theme.color.accent : theme.color.inkDim)};
  background: ${({ theme, $on }) => ($on ? theme.color.accentWash : theme.color.panelRaised)};
`;

export const Controls = styled(Row)`
  gap: ${({ theme }) => theme.space(1)};
  flex-wrap: wrap;
`;

export const ChartBox = styled.div<{ $height?: number }>`
  height: ${({ $height }) => $height ?? 240}px;
  width: 100%;
`;

export const TipCard = styled.div`
  background: ${({ theme }) => theme.color.panel};
  border: 1px solid ${({ theme }) => theme.color.ruleStrong};
  border-radius: ${({ theme }) => theme.radius.control};
  padding: ${({ theme }) => theme.space(2)};
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 11.5px;
  line-height: 1.5;
  box-shadow: ${({ theme }) => theme.color.shadow};
`;

/** A colour chip beside a name: identity is never carried by the fill alone. */
export const Swatch = styled.span<{ $color: string }>`
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: ${({ $color }) => $color};
  flex: none;
`;

export const LegendRow = styled(Row)`
  gap: ${({ theme }) => theme.space(3)};
  flex-wrap: wrap;
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
`;
