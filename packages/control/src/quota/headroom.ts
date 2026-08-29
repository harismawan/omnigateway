import type { ProviderId } from "@omni/ir";
import { quotaRolledOver, type Store, type WindowType } from "@omni/store";
import { burnFor } from "./burn.ts";

/**
 * One provider account's window, as the key holder's own screen reads it.
 *
 * ## What this surface discloses, and why
 *
 * The account is **named**. That is a deliberate widening, taken by the
 * operator: a client screen that collapsed every account of a provider into one
 * "best" row answered "am I about to be throttled" but could not answer "which
 * account is the one filling up", and an operator reading their own client page
 * had strictly less than the console gave them. The cost is stated plainly
 * because it is real — every holder of a gateway API key can sign in at
 * `/client` and now learns how many provider accounts this installation runs and
 * what they are called.
 *
 * What is still withheld is the **size** of an account. Every figure here is a
 * fraction of that window's own ceiling, never the provider's units, so a client
 * learns how full an account is and not how large it is. `formatPercent`
 * multiplies by 100, so these stay in `0..1`; a field already scaled to 0..100
 * rendered as `4200%` the first time one was wired up.
 */
export type AccountQuota = {
  /** Stable per account, and what a chart joins its retained readings on. */
  credentialId: string;
  /** The operator's own name for the account. */
  label: string;
  provider: ProviderId;
  windowType: WindowType;
  /**
   * How much of this window the account has spent, as a ratio in `0..1`.
   *
   * Null where the provider reported no ceiling. Missing data is unknown, never
   * unlimited.
   */
  usedRatio: number | null;
  /** When this window rolls over, or null where the provider did not say. */
  resetsAt: number | null;
  /** When the account was last read; where a chart places the reading. */
  observedAt: number;
  /** The window's own length where the provider stated one, so a start can be derived. */
  windowMs: number | null;
  /**
   * How fast the window is going, as a fraction of its own ceiling per hour.
   *
   * Scaled for the reason `usedRatio` is: the ceiling it would otherwise be
   * counted against is the size of the account. Null where the estimate is
   * suppressed or no ceiling was stated.
   */
  ratePerHourRatio: number | null;
  /** When this window runs out at that rate, or null when it will not or cannot be said. */
  exhaustsAt: number | null;
  /** Whether the window outlives its own reset. Null when the estimate is suppressed. */
  survives: boolean | null;
  /**
   * True when the reading is too old to believe.
   *
   * Decided here rather than on the client, which would need
   * `quotaPollIntervalMs` to re-derive it and that setting lives on a route no
   * client may read.
   */
  stale: boolean;
  /**
   * True when this reading counts a window whose own reset is already behind
   * us.
   *
   * Reported apart from `stale` because the two are different facts and the
   * surfaces phrase them differently: a rolled-over reading is minutes old, so
   * every staleness check calls it current, and blanking its panel would throw
   * away measured history for up to a poll interval after every rollover. What
   * it suppresses is the inference, never the measurement.
   */
  rolledOver: boolean;
};

/**
 * The one place a used/limit pair becomes a ratio.
 *
 * A ceiling of zero is unknown rather than a division: `used / 0` renders as
 * `NaN%`, and a limit nobody stated is not a limit of nothing. Overshoot clamps
 * to fully spent, because spend is debited after the request served and a meter
 * reading "150%" is not a reading.
 */
export function usedRatioOf(used: number, limit: number | null): number | null {
  return limit === null || limit === 0 ? null : Math.min(1, Math.max(0, used / limit));
}

/**
 * Every account's quota windows, as fractions of their own ceilings.
 *
 * Reads the same `quota_windows` rows the operator's panel reads, and keeps the
 * account's identity. What it drops is every provider unit: `used`, `limit` and
 * the units-per-hour rate never leave `@omni/control`, so a client can see that
 * an account is nearly spent without learning what it holds.
 *
 * The conversion happens here rather than in the route so the raw figures are
 * absent from the payload itself. A route that fetched the full shape and
 * divided while rendering would still put the ceilings on the wire the day
 * somebody added a generic serializer.
 */
export async function accountQuota(deps: {
  store: Store;
  now: () => number;
}): Promise<AccountQuota[]> {
  const [windows, credentials, settings] = await Promise.all([
    deps.store.credentials.listQuota(),
    deps.store.credentials.list(),
    deps.store.config.getSettings(),
  ]);
  const now = deps.now();

  const byId = new Map(credentials.map((credential) => [credential.id, credential]));

  const rows: AccountQuota[] = [];
  for (const window of windows) {
    const credential = byId.get(window.credentialId);
    // A quota row whose credential has been removed names an account that no
    // longer serves anything, and has no label to show for it either.
    if (credential === undefined) continue;

    const estimate = burnFor(window, { now, pollIntervalMs: settings.quotaPollIntervalMs });
    const rolledOver = quotaRolledOver(window, now);
    rows.push({
      credentialId: credential.id,
      label: credential.label,
      provider: credential.provider,
      windowType: window.windowType,
      usedRatio: usedRatioOf(window.used, window.limit),
      resetsAt: window.resetsAt,
      observedAt: window.observedAt,
      windowMs: window.windowMs,
      ratePerHourRatio:
        estimate.ratePerHour === null || window.limit === null || window.limit === 0
          ? null
          : estimate.ratePerHour / window.limit,
      exhaustsAt: estimate.exhaustsAt,
      survives: estimate.survives,
      // `burnFor` suppresses on either count, so the age test is what is left
      // once the rollover is taken out. Asked of the same reading it judged.
      stale: estimate.stale && !rolledOver,
      rolledOver,
    });
  }

  return rows.sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.label.localeCompare(b.label) ||
      a.windowType.localeCompare(b.windowType),
  );
}
