import type { ProviderId } from "@omni/ir";
import { quotaStaleAfterMs } from "@omni/router";
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
 * The figures are fractions rather than the provider's own units, and that is a
 * shape decision, not a secret: `formatPercent` multiplies by 100, so these stay
 * in `0..1` — a field already scaled to 0..100 rendered as `4200%` the first
 * time one was wired up.
 *
 * ## The ceiling is derivable, and that is accepted
 *
 * `usedRatio` is the exact quotient of two of the provider's integers, and a
 * ratio of coprime integers comes back in lowest terms through continued
 * fractions. `exhaustsAt` gives it a second way: it is
 * `observedAt + ((limit - used) / ratePerHour) * HOUR`, so together with
 * `resetsAt`, `windowMs` and `windowType` it reduces to `(limit - used) / used`.
 * Rounding the ratios was tried and does not close it — it leaves `exhaustsAt`
 * untouched, and rounding to a thousandth is the identity whenever the ceiling
 * divides 1000, which the small ones do.
 *
 * The operator's decision is that this is acceptable: the account is already
 * named here, and a key holder who can see an account fill up learning roughly
 * how large it is does not add a category of disclosure. **Do not restore a
 * rounding step and claim the size is withheld** — that claim was made once, was
 * false, and a reader who believes it makes worse decisions than one who knows.
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
   * A fraction because that is what the chart plots, not because the units are
   * withheld — see the note above. Null where the estimate is suppressed or no
   * ceiling was stated.
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
 * A ceiling of zero or below is unknown rather than a division: `used / 0`
 * renders as `NaN%`, a negative ceiling is not a quantity anything can be a
 * fraction of, and a limit nobody stated is not a limit of nothing. Overshoot
 * clamps to fully spent, because spend is debited after the request served and
 * a meter reading "150%" is not a reading.
 */
export function usedRatioOf(used: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return Math.min(1, Math.max(0, used / limit));
}

/**
 * Every account's quota windows, as fractions of their own ceilings.
 *
 * Reads the same `quota_windows` rows the operator's panel reads, and keeps the
 * account's identity. What it drops is every provider unit: `used`, `limit` and
 * the units-per-hour rate stay in this package, because the surfaces render
 * percentages and a payload carrying both is a payload two fields from being a
 * copy of the operator's row.
 *
 * The conversion happens here rather than in the route so a generic serializer
 * added later cannot put the raw shape on the wire by default. It is not a
 * secrecy boundary — the type's own note explains why the ceiling is derivable
 * anyway, and that it is meant to be.
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
      // A fraction of this window's own ceiling per hour, which is the shape
      // the chart plots. Not a secrecy measure — see the note on the type.
      ratePerHourRatio:
        estimate.ratePerHour === null || window.limit === null || window.limit <= 0
          ? null
          : estimate.ratePerHour / window.limit,
      exhaustsAt: estimate.exhaustsAt,
      survives: estimate.survives,
      // Asked directly rather than subtracted out of `estimate.stale`.
      //
      // `burnFor` sets that flag on either count and checks age first, so
      // `estimate.stale && !rolledOver` reported `stale: false` for a reading
      // that was *both* — a probe down for hours against a window that has
      // since reset. The panel then printed "rolled over, waiting for the next
      // reading" and said nothing about the probe, which is the half an
      // operator can actually fix. Staleness is said first, the rule the
      // console's own legend follows.
      stale:
        window.observedAt <= 0 ||
        now - window.observedAt > quotaStaleAfterMs(settings.quotaPollIntervalMs),
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
