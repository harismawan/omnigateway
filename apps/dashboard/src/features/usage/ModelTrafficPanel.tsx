import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useProviderCatalog } from "../../api/queries.ts";
import type { CatalogProvider, UsageBucket } from "../../api/types.ts";
import { type ProviderId, providerColor } from "../../theme/tokens.ts";
import { Stack, Truncate } from "../../ui/primitives.ts";
import {
  addTotals,
  asBucket,
  bySplit,
  ChartBox,
  keyToTime,
  LegendRow,
  type Metric,
  Swatch,
  type TimeBy,
  TipCard,
  type Totals,
  timeLabel,
  timeTicks,
  ZERO_TOTALS,
} from "./shared.ts";

/** Beyond this the stack stops separating models and starts hiding them. */
const SHOWN = 6;

/** The band everything past the cut is folded into. Not a model name. */
const OTHER = "__other__";

/** What the store calls a request whose upstream model was never resolved. */
const UNKNOWN = "unknown";

type Band = { name: string; label: string; color: string; totals: Totals };

/** A provider id, or null for traffic no provider could be attributed to. */
type Attributed = string | null;

export type ModelTrafficPanelProps = {
  /** Time buckets split by upstream model. */
  buckets: readonly UsageBucket[];
  by: TimeBy;
  since: number;
  until: number;
  metric: Metric;
  /** Upstream model to the provider a configured target sends it to. */
  providers: ReadonlyMap<string, ProviderId>;
};

/**
 * Which provider serves an upstream model. The operator's own targets answer
 * first — they are what this gateway actually routes — and the catalog covers
 * a model that used to be configured and no longer is. Anything neither knows
 * stays unattributed rather than being guessed at from its name.
 */
function providerOf(
  catalog: readonly CatalogProvider[],
  model: string,
  configured: ReadonlyMap<string, ProviderId>,
): Attributed {
  const routed = configured.get(model);
  if (routed !== undefined) return routed;
  return (
    catalog.find((provider) => provider.models.some((entry) => entry.id === model))?.id ?? null
  );
}

/**
 * A band keeps its provider's hue and gives up a step of it per model, so the
 * chart still says only the two things colour is allowed to say here: which
 * provider carried the traffic, and — by weight rather than by a new hue —
 * which of that provider's models carried it.
 */
function shadeOf(provider: Attributed, step: number): string {
  if (provider === null) return "var(--ink-faint)";
  return `color-mix(in oklch, ${providerColor(provider)} ${Math.max(30, 100 - step * 22)}%, var(--panel))`;
}

/**
 * The window's traffic cut by the model that actually served it, read through
 * the shared lens: tokens by default, because a request routed to a large model
 * is not the same unit of work as one routed to a small one, and cost or
 * requests when the operator asks the rest of the deck for those.
 */
export function ModelTrafficPanel({
  buckets,
  by,
  since,
  until,
  metric,
  providers,
}: ModelTrafficPanelProps) {
  // Loaded before this screen mounts, by the gate in `routes/_app.tsx`.
  const catalog = useProviderCatalog().data ?? [];
  const ranked = [...bySplit(buckets, metric).entries()];
  const kept = ranked.slice(0, SHOWN);
  const rest = ranked.slice(SHOWN);

  // Grouped by provider so the shade ramp reads as one hue stepping down, and
  // walked in the fixed provider order so a model going quiet never recolours
  // the ones that stayed.
  const bands: Band[] = [];
  for (const provider of [...catalog.map((entry) => entry.id), null]) {
    kept
      .filter(([name]) => providerOf(catalog, name, providers) === provider)
      .forEach(([name, totals], index) => {
        bands.push({
          name,
          label: name === UNKNOWN ? "Unresolved" : name,
          color: shadeOf(provider, index),
          totals,
        });
      });
  }
  if (rest.length > 0) {
    bands.push({
      name: OTHER,
      label: `${rest.length} more`,
      color: "var(--ink-faint)",
      totals: rest.reduce((sum, [, totals]) => addTotals(sum, asBucket(totals)), ZERO_TOTALS),
    });
  }

  const drawn = new Set(kept.map(([name]) => name));
  const cells = new Map<string, number>();
  for (const bucket of buckets) {
    const model = bucket.split ?? UNKNOWN;
    const id = `${keyToTime(bucket.key, by)} ${drawn.has(model) ? model : OTHER}`;
    cells.set(id, (cells.get(id) ?? 0) + metric.of(bucket));
  }
  const rows = timeTicks(since, until, by).map((at) => {
    const row: Record<string, number> = { at };
    for (const band of bands) row[band.name] = cells.get(`${at} ${band.name}`) ?? 0;
    return row;
  });
  const labels = new Map(bands.map((band) => [band.name, band.label]));

  return (
    <Stack $gap={2}>
      <ChartBox $height={220}>
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
              tickFormatter={(value: number) => metric.format(value)}
              tick={{ fill: "var(--ink-faint)", fontSize: 10 }}
              stroke="var(--rule-strong)"
              width={40}
            />
            <Tooltip
              cursor={{ stroke: "var(--rule-strong)" }}
              content={({ active, payload, label }) => {
                if (active !== true || payload === undefined || payload.length === 0) return null;
                // A stack this deep is mostly zeroes at any one tick; listing
                // them would bury the models that were actually serving.
                const carried = payload.filter((entry) => Number(entry.value ?? 0) > 0);
                return (
                  <TipCard>
                    <div>{timeLabel(Number(label), by)}</div>
                    {carried.length === 0 ? (
                      <div>{`No ${metric.label.toLowerCase()}`}</div>
                    ) : (
                      carried.map((entry) => (
                        <div key={String(entry.dataKey)}>
                          {labels.get(String(entry.dataKey)) ?? String(entry.dataKey)}{" "}
                          {metric.format(Number(entry.value ?? 0))}
                        </div>
                      ))
                    )}
                  </TipCard>
                );
              }}
            />
            {bands.map((band) => (
              <Area
                key={band.name}
                type="monotone"
                dataKey={band.name}
                stackId="models"
                stroke={band.color}
                strokeWidth={2}
                fill={band.color}
                fillOpacity={0.22}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </ChartBox>

      <LegendRow>
        {bands.map((band) => (
          <span key={band.name}>
            <Swatch $color={band.color} />{" "}
            <Truncate
              title={`${band.label}: ${metric.format(metric.of(asBucket(band.totals)))} ${metric.label.toLowerCase()}`}
              style={{ display: "inline-block", maxWidth: "24ch", verticalAlign: "bottom" }}
            >
              {band.label}
            </Truncate>
          </span>
        ))}
      </LegendRow>
    </Stack>
  );
}
