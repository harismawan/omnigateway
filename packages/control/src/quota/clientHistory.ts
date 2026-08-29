import type { ProviderId } from "@omni/ir";
import type { Store, WindowType } from "@omni/store";
import { usedRatioOf } from "./headroom.ts";
import { retainedSpan } from "./history.ts";

/**
 * One retained reading of one account's quota window, as a fraction.
 *
 * The same disclosure `AccountQuota` makes, over time rather than at now: the
 * account is named, and the ceiling behind the fraction is derivable — see the
 * note on that type. `usedRatio` is never null here — a
 * reading against an unstated ceiling is not a percentage of anything, and it is
 * dropped rather than drawn at zero, the rule `quotaSegments` already applies to
 * the operator's own readings.
 */
export type AccountQuotaSample = {
  credentialId: string;
  label: string;
  provider: ProviderId;
  windowType: WindowType;
  observedAt: number;
  usedRatio: number;
  resetsAt: number | null;
  windowMs: number | null;
};

export type AccountQuotaHistoryInput = {
  since?: string | number | undefined;
  until?: string | number | undefined;
};

export type AccountQuotaHistoryResult = {
  samples: AccountQuotaSample[];
  /**
   * True when the page overflowed, so the oldest readings in the span were cut.
   *
   * Said rather than absorbed. The chart states its own x domain from the span
   * it requested — deliberately, so the axis describes the window rather than
   * the samples — and a shortened series drawn against it is an empty stretch
   * that reads exactly like a gateway that was not running.
   *
   * A property of the read, which covers every account at once. A surface
   * drawing one series must decide for *that* series whether it starts late:
   * the cap can be reached by accounts the reader is not looking at, and the
   * note belongs on a chart that is actually short, not on every chart.
   */
  truncated: boolean;
};

/**
 * The furthest back a client may reach, whatever retention allows.
 *
 * This route is reachable by every key holder and, unlike the operator's, is
 * scoped to no credential: it reads every account's samples in the span. With
 * no ceiling, a parameterless GET fell back to the retention window — thirty
 * days by default — and `bun:sqlite` is synchronous, so that scan blocks the
 * whole event loop rather than one request.
 *
 * Sixteen days covers what the screen asks for: the widest window a provider
 * reports is a week, and the chart plots that window plus the one before it.
 */
const MAX_SPAN_MS = 16 * 24 * 60 * 60 * 1_000;

/**
 * And at most this many rows out of that span.
 *
 * A runaway guard, not a working limit, and the distinction is the whole of
 * this constant's history: it was 8_000 on the reasoning that "a window's line
 * is a few hundred points", which is wrong by an order of magnitude. A weekly
 * window charted with its predecessor spans fourteen days, and at the default
 * five-minute poll that is ~4_000 readings per credential-window — so a single
 * account with two windows already exceeded 8_000 and had its chart silently
 * shortened to a fraction of the axis it was drawn against.
 *
 * Fifty thousand is past what any install this surface is built for produces in
 * sixteen days, while still bounding a `bun:sqlite` read that is synchronous and
 * reachable by every key holder. Hitting it is a real condition rather than a
 * routine one, so it is reported rather than absorbed — see `truncated`.
 */
const MAX_SAMPLES = 50_000;

/**
 * The retained readings behind the client screen's quota charts.
 *
 * One series per account and window, which is what lets a key holder see which
 * account is filling up rather than only that one of them is.
 *
 * ## What is not here
 *
 * No gateway rate. The operator's panel corroborates provider units against this
 * gateway's own token throughput, and that aggregate covers every key on the
 * installation — a number about the operator's traffic, not this client's, and
 * one no client is entitled to.
 *
 * No `used` and no `limit`, for the reason `AccountQuota` omits them: the chart
 * plots percentages, so the counts would be two more fields nobody reads. It is
 * not a secrecy measure — a series of exact ratios sharing one denominator
 * gives the ceiling back, and `AccountQuota` explains why that is accepted
 * rather than papered over.
 */
export async function accountQuotaHistory(
  deps: { store: Store; now: () => number },
  input: AccountQuotaHistoryInput,
): Promise<AccountQuotaHistoryResult> {
  const { since, until } = await retainedSpan(deps, input, MAX_SPAN_MS);

  const [samples, credentials] = await Promise.all([
    // One more than the cap, so a page that is *exactly* full can be told from
    // one that was cut. Asking for the cap made `length >= MAX_SAMPLES` true
    // for a complete history of exactly that size, and every chart on the page
    // then claimed readings were missing when none were.
    deps.store.credentials.listQuotaSamples({ since, until, limit: MAX_SAMPLES + 1 }),
    deps.store.credentials.list(),
  ]);

  const byId = new Map(credentials.map((credential) => [credential.id, credential]));

  // The page overflowed, so the oldest readings in the span were cut. Decided
  // before the extra row is dropped, and reported per series below rather than
  // for the request as a whole.
  const truncated = samples.length > MAX_SAMPLES;
  const page = truncated ? samples.slice(0, MAX_SAMPLES) : samples;

  const out: AccountQuotaSample[] = [];
  for (const sample of page) {
    const credential = byId.get(sample.credentialId);
    // A sample whose credential is gone names an account that no longer serves
    // anything, exactly as the live reading of it would.
    if (credential === undefined) continue;

    const usedRatio = usedRatioOf(sample.used, sample.limit);
    if (usedRatio === null) continue;

    out.push({
      credentialId: credential.id,
      label: credential.label,
      provider: credential.provider,
      windowType: sample.windowType,
      observedAt: sample.observedAt,
      usedRatio,
      resetsAt: sample.resetsAt,
      windowMs: sample.windowMs,
    });
  }

  return {
    samples: out.sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.label.localeCompare(b.label) ||
        a.windowType.localeCompare(b.windowType) ||
        a.observedAt - b.observedAt,
    ),
    truncated,
  };
}
