import { useMemo, useState } from "react";
import styled from "styled-components";
import { useCredentials, useKeys, useModels, useUsage } from "../../api/queries.ts";
import type { ProviderId, UsageDimension } from "../../api/types.ts";
import { PageHead } from "../../components/Rack.tsx";
import { formatCount, formatMs, formatPercent, formatUsd } from "../../lib/format.ts";
import { useLive } from "../../session/live.tsx";
import { Grid, Stack } from "../../ui/primitives.ts";
import { Readout } from "../../ui/Readout.tsx";
import { Sparkline } from "../../ui/Sparkline.tsx";
import { ActivityGrid } from "./ActivityGrid.tsx";
import { KeyPanel } from "./KeyPanel.tsx";
import { ModelTrafficPanel } from "./ModelTrafficPanel.tsx";
import { ProviderPanel } from "./ProviderPanel.tsx";
import { RankPanel } from "./RankPanel.tsx";
import { Section } from "./Section.tsx";
import {
  ACTIVITY_DAYS,
  allTokens,
  Controls,
  keyToTime,
  METRICS,
  type MetricId,
  metricOf,
  RANGES,
  type RangeId,
  rangeOf,
  Segment,
  startOfDay,
  timeTicks,
  totalsOf,
} from "./shared.ts";
import { TokenMixPanel } from "./TokenMixPanel.tsx";
import { TrafficPanel } from "./TrafficPanel.tsx";

const Deck = styled.div`
  display: grid;
  grid-template-columns: repeat(
    auto-fit,
    minmax(max(180px, calc((100% - 4 * ${({ theme }) => theme.space(3)}) / 5)), 1fr)
  );
  gap: ${({ theme }) => theme.space(3)};
`;

const DAY_MS = 86_400_000;

const MODEL_SCOPES = [
  { id: "requestedModel", label: "As requested", column: "Virtual model" },
  { id: "model", label: "As served", column: "Upstream model" },
] as const satisfies ReadonlyArray<{ id: UsageDimension; label: string; column: string }>;

type ModelScope = (typeof MODEL_SCOPES)[number]["id"];

/**
 * The usage deck: a year of activity at the top, then the selected window
 * broken down by provider, model, key, and token class. Every panel reads the
 * same window, so two panels can always be compared without re-reading their
 * headers.
 */
export function UsageBoard() {
  const { cadence } = useLive();
  const [rangeId, setRangeId] = useState<RangeId>("24h");
  const [metricId, setMetricId] = useState<MetricId>("tokens");
  const [scope, setScope] = useState<ModelScope>("model");

  const range = rangeOf(rangeId);
  const metric = metricOf(metricId);

  // Pinned per range so the query key does not change on every tick: to the
  // minute for raw windows, to the day for rollup ones.
  const since = useMemo(
    () =>
      range.grain === "daily"
        ? startOfDay(Date.now() - range.ms)
        : Math.floor((Date.now() - range.ms) / 60_000) * 60_000,
    [range],
  );
  const until = useMemo(() => since + range.ms, [since, range]);
  const activitySince = useMemo(() => startOfDay(Date.now() - ACTIVITY_DAYS * DAY_MS), []);

  const common = { since, grain: range.grain } as const;
  const series = useUsage({ ...common, groupBy: range.by }, cadence(60_000, "res:usage"));
  const providers = useUsage(
    { ...common, groupBy: range.by, splitBy: "provider" },
    cadence(60_000, "res:usage"),
  );
  const modelTraffic = useUsage(
    { ...common, groupBy: range.by, splitBy: "model" },
    cadence(60_000, "res:usage"),
  );
  const keyTraffic = useUsage(
    { ...common, groupBy: range.by, splitBy: "apiKey" },
    cadence(60_000, "res:usage"),
  );
  const models = useUsage({ ...common, groupBy: scope }, cadence(60_000, "res:usage"));
  const accounts = useUsage({ ...common, groupBy: "credential" }, cadence(60_000, "res:usage"));
  // A year of squares changes slowly; polling it at the panel cadence is waste.
  const activity = useUsage(
    { since: activitySince, grain: "daily", groupBy: "day" },
    cadence(300_000, "res:usage"),
  );

  const keys = useKeys();
  const credentials = useCredentials();
  const virtualModels = useModels();
  // Which provider an upstream model is served by, taken from the targets the
  // operator configured. A model no longer routed anywhere falls through to the
  // catalog inside the panel.
  const modelProviders = useMemo(() => {
    const routed = new Map<string, ProviderId>();
    for (const model of virtualModels.data ?? []) {
      for (const target of model.targets) routed.set(target.model, target.provider);
    }
    return routed;
  }, [virtualModels.data]);
  const keyNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const key of keys.data ?? []) names.set(key.id, key.label);
    return names;
  }, [keys.data]);
  const accountNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const entry of credentials.data ?? []) names.set(entry.id, entry.label);
    return names;
  }, [credentials.data]);

  const buckets = series.data ?? [];
  const totals = totalsOf(buckets);
  const promptInput = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  const tokens = allTokens(totals);
  const meanOutput = totals.requests === 0 ? 0 : totals.outputTokens / totals.requests;
  const cacheReadRate = promptInput === 0 ? 0 : totals.cacheReadTokens / promptInput;
  const cacheWriteRate = promptInput === 0 ? 0 : totals.cacheWriteTokens / promptInput;
  const meanCost = totals.requests === 0 ? 0 : totals.costUsd / totals.requests;

  // The vitals traces share the window's ticks with the charts below them.
  const ticks = timeTicks(since, until, range.by);
  const byTick = new Map(buckets.map((bucket) => [keyToTime(bucket.key, range.by), bucket]));
  const trace = (of: (at: number) => number): number[] => ticks.map(of);
  const errorTone = (rate: number): "ok" | "warn" | "down" =>
    rate >= 0.25 ? "down" : rate >= 0.05 ? "warn" : "ok";
  const errorRate = totals.requests === 0 ? 0 : totals.errors / totals.requests;

  const empty = {
    legend: "Nothing recorded",
    message:
      "No requests landed in this window. Widen the range, or send traffic through the gateway.",
  };

  return (
    <Stack $gap={4}>
      <PageHead
        legend="Usage"
        title="Requests, tokens, and spend"
        summary={
          series.isLoading
            ? "Reading usage…"
            : `${formatCount(totals.requests)} requests and ${formatUsd(totals.costUsd)} over the last ${range.label}.`
        }
        actions={
          <Controls>
            {RANGES.map((entry) => (
              <Segment
                key={entry.id}
                type="button"
                $size="sm"
                $on={entry.id === rangeId}
                aria-pressed={entry.id === rangeId}
                onClick={() => setRangeId(entry.id)}
              >
                {entry.id}
              </Segment>
            ))}
          </Controls>
        }
      />

      <Deck data-testid="usage-summary-deck">
        <Readout
          legend="Requests"
          value={formatCount(totals.requests)}
          unit={range.label}
          trace={
            <Sparkline
              values={trace((at) => byTick.get(at)?.requests ?? 0)}
              overlay={trace((at) => byTick.get(at)?.errors ?? 0)}
              label={`${totals.requests} requests, ${totals.errors} of them failed`}
            />
          }
        />
        <Readout
          legend="Error rate"
          value={formatPercent(errorRate)}
          unit={`${formatCount(totals.errors)} failed`}
          tone={totals.requests === 0 ? "ink" : errorTone(errorRate)}
          trace={
            <Sparkline
              values={trace((at) => {
                const bucket = byTick.get(at);
                return bucket === undefined || bucket.requests === 0
                  ? 0
                  : bucket.errors / bucket.requests;
              })}
              color="var(--down)"
              label={`${totals.errors} failed requests against ${totals.requests} total`}
            />
          }
        />
        <Readout
          legend="Prompt input"
          value={formatCount(promptInput)}
          unit={`${formatCount(totals.inputTokens)} uncached`}
          trace={
            <Sparkline
              values={trace((at) => {
                const bucket = byTick.get(at);
                return (
                  (bucket?.inputTokens ?? 0) +
                  (bucket?.cacheReadTokens ?? 0) +
                  (bucket?.cacheWriteTokens ?? 0)
                );
              })}
              label={`${promptInput} prompt input tokens over the window`}
            />
          }
        />
        <Readout
          legend="Output"
          value={formatCount(totals.outputTokens)}
          unit={`mean ${formatCount(meanOutput)}/request`}
          trace={
            <Sparkline
              values={trace((at) => byTick.get(at)?.outputTokens ?? 0)}
              label={`${totals.outputTokens} output tokens over the window`}
            />
          }
        />
        <Readout
          legend="Cache reads"
          value={formatCount(totals.cacheReadTokens)}
          unit={`${formatPercent(cacheReadRate, 0)} of prompt`}
          trace={
            <Sparkline
              values={trace((at) => byTick.get(at)?.cacheReadTokens ?? 0)}
              label={`${totals.cacheReadTokens} cache-read tokens over the window`}
            />
          }
        />
        <Readout
          legend="Cache writes"
          value={formatCount(totals.cacheWriteTokens)}
          unit={`${formatPercent(cacheWriteRate, 0)} of prompt`}
          trace={
            <Sparkline
              values={trace((at) => byTick.get(at)?.cacheWriteTokens ?? 0)}
              label={`${totals.cacheWriteTokens} cache-write tokens over the window`}
            />
          }
        />
        <Readout
          legend="RTK saved"
          value={formatCount(totals.rtkSavedTokens)}
          unit={`${formatCount(totals.rtkAppliedRequests)} requests`}
          trace={
            <Sparkline
              values={trace((at) => byTick.get(at)?.rtkSavedTokens ?? 0)}
              label={`${totals.rtkSavedTokens} estimated tokens saved by RTK over the window`}
            />
          }
        />
        <Readout
          legend="Mean duration"
          value={formatMs(totals.requests === 0 ? null : totals.durationMsSum / totals.requests)}
          unit="per request"
          trace={
            <Sparkline
              values={trace((at) => {
                const bucket = byTick.get(at);
                return bucket === undefined || bucket.requests === 0
                  ? 0
                  : bucket.durationMsSum / bucket.requests;
              })}
              color="var(--ok)"
              label="mean request duration over the window"
            />
          }
        />
        <Readout
          legend="Spend"
          value={formatUsd(totals.costUsd)}
          unit={range.label}
          trace={
            <Sparkline
              values={trace((at) => byTick.get(at)?.costUsd ?? 0)}
              color="var(--warn)"
              label={`spend over the window, ${formatUsd(totals.costUsd)} total`}
            />
          }
        />
        <Readout
          legend="Cost / request"
          value={formatUsd(meanCost)}
          unit="mean"
          trace={
            <Sparkline
              values={trace((at) => {
                const bucket = byTick.get(at);
                return bucket === undefined || bucket.requests === 0
                  ? 0
                  : bucket.costUsd / bucket.requests;
              })}
              color="var(--warn)"
              label={`${formatUsd(meanCost)} mean cost per request over the window`}
            />
          }
        />
      </Deck>

      <Section
        legend="Traffic"
        meta={range.by === "hour" ? "By hour" : "By day"}
        query={series}
        isEmpty={buckets.length === 0}
        empty={empty}
      >
        <TrafficPanel buckets={buckets} by={range.by} since={since} until={until} />
      </Section>

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
            {`Rank by ${entry.label.toLowerCase()}`}
          </Segment>
        ))}
      </Controls>

      {/* Full width above the columns: it is the same window as the trace at
          the top of the page, cut by the model that served it, and a stack of
          seven bands needs the whole rack to stay legible. It reads through the
          shared lens, so the control above it moves this panel too. */}
      <Section
        legend="Traffic by upstream model"
        meta={`${metric.label}, ${range.by === "hour" ? "by hour" : "by day"}`}
        query={modelTraffic}
        isEmpty={(modelTraffic.data ?? []).length === 0}
        empty={empty}
      >
        <ModelTrafficPanel
          buckets={modelTraffic.data ?? []}
          by={range.by}
          since={since}
          until={until}
          metric={metric}
          providers={modelProviders}
        />
      </Section>

      {/* Two explicit columns rather than a flowing grid: panels differ in
          height, and an auto-placed grid leaves a hole under every short one.
          Each column stacks flush and the pair is balanced by eye. */}
      <Grid $min="480px" $gap={4}>
        <Stack $gap={4}>
          <Section
            legend="Providers"
            meta={metric.label}
            query={providers}
            isEmpty={(providers.data ?? []).length === 0}
            empty={empty}
          >
            <ProviderPanel
              buckets={providers.data ?? []}
              by={range.by}
              since={since}
              until={until}
              metric={metric}
            />
          </Section>

          {/* The year sits among the breakdowns rather than above them: it is one
              more way to read the same traffic, not a header for the page. */}
          <ActivityGrid days={activity.data ?? []} now={Date.now()} />
        </Stack>

        <Stack $gap={4}>
          <Section
            legend="Token mix"
            meta={formatCount(tokens)}
            query={series}
            isEmpty={buckets.length === 0}
            empty={empty}
          >
            <TokenMixPanel buckets={buckets} by={range.by} since={since} until={until} />
          </Section>

          <Section
            legend="Models"
            meta={MODEL_SCOPES.find((entry) => entry.id === scope)?.column}
            query={models}
            isEmpty={(models.data ?? []).length === 0}
            empty={empty}
            actions={
              <Controls>
                {MODEL_SCOPES.map((entry) => (
                  <Segment
                    key={entry.id}
                    type="button"
                    $size="sm"
                    $on={entry.id === scope}
                    aria-pressed={entry.id === scope}
                    onClick={() => setScope(entry.id)}
                  >
                    {entry.label}
                  </Segment>
                ))}
              </Controls>
            }
          >
            <RankPanel buckets={models.data ?? []} metric={metric} />
          </Section>

          <Section
            legend="Accounts"
            meta={metric.label}
            query={accounts}
            isEmpty={(accounts.data ?? []).length === 0}
            empty={empty}
          >
            <RankPanel
              buckets={accounts.data ?? []}
              metric={metric}
              names={accountNames}
              unknownLabel="No account"
            />
          </Section>
        </Stack>
      </Grid>

      {/* Full width: seven columns and a trace per key do not fit a grid cell. */}
      <Section
        legend="API keys"
        meta={metric.label}
        query={keyTraffic}
        isEmpty={(keyTraffic.data ?? []).length === 0}
        empty={empty}
      >
        <KeyPanel
          buckets={keyTraffic.data ?? []}
          by={range.by}
          since={since}
          until={until}
          metric={metric}
          names={keyNames}
        />
      </Section>
    </Stack>
  );
}
