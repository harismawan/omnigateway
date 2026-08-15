import type { QuotaSample, QuotaWindow, Store, WindowType } from "@omni/store";
import { optionalNumber } from "../schemas.ts";
import { windowStartOf } from "./burn.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 3_600_000;

export type QuotaHistoryInput = {
  since?: string | number | undefined;
  until?: string | number | undefined;
  /** Omitted means every credential. */
  credentialId?: string | undefined;
};

/**
 * What this gateway can account for over the span the provider rate covers.
 *
 * Corroboration, never a share: provider units and gateway tokens do not
 * convert. Where the two diverge, something other than this gateway is spending
 * the account, and that is the whole reason to show it.
 */
export type GatewayRate = {
  credentialId: string;
  windowType: WindowType;
  /** Null when the window start is unknown, so there is no span to divide by. */
  gatewayRatePerHour: number | null;
};

export type QuotaHistoryResult = {
  samples: QuotaSample[];
  gatewayRates: GatewayRate[];
};

/**
 * The gateway's own rate for each snapshot window, over that window's span.
 *
 * One aggregate per window rather than one per distinct span: spans are keyed
 * off `observedAt`, which the poller stamps per credential, so no two
 * credentials ever share one. Pretending otherwise bought a dead cache and
 * twelve week-scale scans.
 *
 * This is why the rate lives here and not on `/api/credentials/health`: scoped
 * to one credential it is one to three aggregates, asked for once when a row is
 * expanded, instead of twelve every ten seconds.
 */
async function gatewayRatesFor(
  store: Store,
  windows: readonly QuotaWindow[],
): Promise<GatewayRate[]> {
  const rates: GatewayRate[] = [];
  for (const window of windows) {
    const since = windowStartOf(window);
    if (since === null || window.observedAt <= since) {
      rates.push({
        credentialId: window.credentialId,
        windowType: window.windowType,
        gatewayRatePerHour: null,
      });
      continue;
    }

    const rows = await store.usage.aggregate({
      grain: "raw",
      groupBy: "credential",
      since,
      // Anchored to the reading, never to the clock. The gateway knows its own
      // logs in real time, but a rate over more hours than the provider counted
      // is not comparable with the provider's.
      until: window.observedAt,
    });
    const row = rows.find((r) => r.key === window.credentialId);
    // Every class the provider's own counter is charged for. Dropping the
    // cached ones would understate what this gateway accounts for and
    // manufacture a divergence from the provider rate that is not there.
    const tokens =
      row === undefined
        ? 0
        : row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;

    rates.push({
      credentialId: window.credentialId,
      windowType: window.windowType,
      gatewayRatePerHour: tokens / ((window.observedAt - since) / HOUR_MS),
    });
  }
  return rates;
}

/**
 * The retained readings for a span, as the Accounts disclosure charts them,
 * plus the gateway rate that corroborates them.
 *
 * The burn estimate itself stays on the health endpoint: it derives from one
 * snapshot row and costs nothing. The gateway rate does not — it is a
 * request-log aggregate over the window's whole span — so it belongs on this
 * endpoint, which is fetched only while a row is expanded and is not on a
 * refetch interval.
 *
 * The sample span is clamped to what pruning leaves readable, so a request for
 * "everything" cannot read further back than the rows actually go. The gateway
 * rate ignores that span deliberately: it is anchored to the reading, exactly
 * as the provider rate is, and the two are only comparable if they cover the
 * same hours.
 */
export async function quotaHistory(
  deps: { store: Store; now: () => number },
  input: QuotaHistoryInput,
): Promise<QuotaHistoryResult> {
  const now = deps.now();
  const settings = await deps.store.config.getSettings();
  const oldest = now - settings.logRetentionDays * DAY_MS;

  const since = Math.max(optionalNumber(input.since, oldest), oldest);
  const until = Math.min(optionalNumber(input.until, now), now);
  const raw = input.credentialId?.trim();
  const credentialId = raw === undefined || raw.length === 0 ? undefined : raw;

  const [samples, quota] = await Promise.all([
    deps.store.credentials.listQuotaSamples({
      since,
      until,
      ...(credentialId === undefined ? {} : { credentialId }),
    }),
    deps.store.credentials.listQuota(),
  ]);

  const scoped =
    credentialId === undefined ? quota : quota.filter((w) => w.credentialId === credentialId);

  return { samples, gatewayRates: await gatewayRatesFor(deps.store, scoped) };
}
