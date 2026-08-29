import { quotaRolledOver } from "@omni/store/types";
import { useQuotaHistory } from "../../api/queries.ts";
import type { BurnEstimate, GatewayRate, QuotaWindow } from "../../api/types.ts";
import { formatCount } from "../../lib/format.ts";
import { burnOf, isQuotaStale, rateRatioOf, readingOf } from "../../lib/vitals.ts";
import { Stack } from "../../ui/primitives.ts";
import { chartSpanOf, ExtraFact, WindowChart } from "../quota/WindowChart.tsx";

export { PACE_DASH } from "../quota/WindowChart.tsx";

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
    return { window, estimate, since: chartSpanOf(readingOf(window)) };
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
        <AccountWindow
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

type AccountWindowProps = {
  window: QuotaWindow;
  estimate: BurnEstimate | undefined;
  since: number | null;
  samples: readonly Parameters<typeof readingOf>[0][];
  /** Absent until the history request lands, and null when it has no span. */
  gatewayRate: GatewayRate | undefined;
  pollIntervalMs: number;
  now: number;
};

/**
 * One window of one account, said in the units the provider reports.
 *
 * The chart itself is shared with the client surface, which is told fractions
 * rather than counts; what this adds is the operator's vocabulary and the one
 * fact only an operator may see — how much of the provider's counter this
 * gateway can account for.
 */
function AccountWindow({
  window,
  estimate,
  since,
  samples,
  gatewayRate,
  pollIntervalMs,
  now,
}: AccountWindowProps) {
  const spent =
    window.limit === null
      ? `${formatCount(window.used)} used`
      : `${formatCount(window.used)} of ${formatCount(window.limit)} used`;

  // The same rule the bars and the router use, decided here because only this
  // surface holds the poll interval to age a reading against. A rolled-over
  // window is not that case and is passed on separately: `burnFor` suppresses
  // every claim about a window still being spent while keeping where it began,
  // and the readings underneath were measured and stay measured.
  const rolledOver = quotaRolledOver(window, now);
  const stale =
    estimate === undefined ||
    isQuotaStale(window, now, pollIntervalMs) ||
    (estimate.stale && !rolledOver);

  return (
    <WindowChart
      live={readingOf(window)}
      samples={samples.map(readingOf)}
      since={since}
      now={now}
      ratePerHourRatio={rateRatioOf(window, estimate)}
      exhaustsAt={estimate?.exhaustsAt ?? null}
      survives={estimate?.survives ?? null}
      stale={stale}
      rolledOver={rolledOver}
      spent={spent}
      rateText={
        estimate?.ratePerHour === undefined || estimate.ratePerHour === null
          ? "unknown"
          : `${formatCount(estimate.ratePerHour)}/h`
      }
      extraFact={
        <ExtraFact
          // Provider units and gateway tokens do not convert, so this is a
          // second rate beside the first, never a share of it.
          legend="This gateway accounts for"
          value={
            gatewayRate?.gatewayRatePerHour === undefined || gatewayRate.gatewayRatePerHour === null
              ? "unknown"
              : `${formatCount(gatewayRate.gatewayRatePerHour)} tokens/h`
          }
        />
      }
    />
  );
}
