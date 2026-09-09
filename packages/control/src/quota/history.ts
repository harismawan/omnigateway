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
  /** The span held more readings than the page; the oldest were cut. */
  truncated: boolean;
};

/**
 * At most this many rows out of a span.
 *
 * A runaway guard, not a working limit, and the distinction is the whole of this
 * constant's history: it was 8_000 on the reasoning that "a window's line is a
 * few hundred points", which is wrong by an order of magnitude. A weekly window
 * charted with its predecessor spans fourteen days, and at the default
 * five-minute poll that is ~4_000 readings per credential-window — so a single
 * account with two windows already exceeded 8_000 and had its chart silently
 * shortened to a fraction of the axis it was drawn against.
 *
 * Fifty thousand is past what any install these surfaces are built for produces,
 * while still bounding a `bun:sqlite` read that is synchronous — an uncapped one
 * blocks the whole event loop, the reason the unbounded `SELECT SUM` behind
 * `usage_rollup` was removed. Hitting it is a real condition rather than a
 * routine one, so it is reported rather than absorbed — see `truncated`.
 *
 * Lives here beside `retainedSpan` for the same reason that does: both surfaces
 * that read samples go through it. The console's read was uncapped while the
 * client's was not, so the route reachable by every key holder was the bounded
 * one, and the operator's — every account over the whole retention window, and
 * `requireReader` rather than `requireAdmin` — was not.
 */
export const MAX_SAMPLES = 50_000;

/** One more than the cap, so a page that is *exactly* full can be told from a cut one. */
export const SAMPLE_QUERY_LIMIT = MAX_SAMPLES + 1;

/**
 * Trims an over-full page and says so.
 *
 * Asking for the cap made `length >= MAX_SAMPLES` true for a complete history of
 * exactly that size, and every chart then claimed readings were missing when
 * none were — hence the extra row rather than a comparison against the cap.
 */
export function pageSamples(samples: QuotaSample[]): {
  page: QuotaSample[];
  truncated: boolean;
} {
  const truncated = samples.length > MAX_SAMPLES;
  return { page: truncated ? samples.slice(0, MAX_SAMPLES) : samples, truncated };
}

/**
 * The span a retained-reading request actually covers.
 *
 * Clamped to what pruning leaves readable, so a request for "everything" cannot
 * read further back than the rows go, and forward to the clock, so a span
 * cannot reach into the future. Both surfaces that read samples go through
 * this: two copies of the clamp would be two answers to "how far back does this
 * install remember", and the one that drifted would be silently wrong rather
 * than broken.
 */
export async function retainedSpan(
  deps: { store: Store; now: () => number },
  input: { since?: string | number | undefined; until?: string | number | undefined },
  /**
   * The furthest back this caller may reach, where it is narrower than
   * retention.
   *
   * `/api/credentials/quota/history` passes none: it is scoped to one
   * credential and fetched only while a row is expanded. The client route
   * passes one because it is reachable by every key holder and reads every
   * credential at once. See `accountQuotaHistory`.
   *
   * Note the console route is `requireReader`, so a read-only administrator
   * reaches the unbounded form too — a parameterless GET there is the whole
   * retention window across every account, which is the same synchronous read
   * this ceiling exists to bound. It predates this parameter and is not made
   * worse by it, but it is not "the operator's alone" either.
   */
  maxSpanMs?: number,
): Promise<{ since: number; until: number }> {
  const now = deps.now();
  const settings = await deps.store.config.getSettings();
  const retained = now - settings.logRetentionDays * DAY_MS;
  const oldest = maxSpanMs === undefined ? retained : Math.max(retained, now - maxSpanMs);

  return {
    since: Math.max(optionalNumber(input.since, oldest), oldest),
    until: Math.min(optionalNumber(input.until, now), now),
  };
}

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
  const { since, until } = await retainedSpan(deps, input);
  const raw = input.credentialId?.trim();
  const credentialId = raw === undefined || raw.length === 0 ? undefined : raw;

  const [samples, quota] = await Promise.all([
    deps.store.credentials.listQuotaSamples({
      since,
      until,
      limit: SAMPLE_QUERY_LIMIT,
      ...(credentialId === undefined ? {} : { credentialId }),
    }),
    deps.store.credentials.listQuota(),
  ]);

  const scoped =
    credentialId === undefined ? quota : quota.filter((w) => w.credentialId === credentialId);

  const { page, truncated } = pageSamples(samples);
  return { samples: page, truncated, gatewayRates: await gatewayRatesFor(deps.store, scoped) };
}
