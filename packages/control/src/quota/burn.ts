import { quotaStaleAfterMs } from "@omni/router";
import { durationFor, type QuotaWindow, quotaRolledOver, type WindowType } from "@omni/store";

/**
 * How fast a quota window is being spent, and whether it will last.
 *
 * Everything here is derived from one reading. `quota_samples` exists to draw a
 * chart; the estimate is a whole-window average and needs only the newest
 * snapshot, which is what lets it ride the health endpoint and appear on a
 * freshly upgraded install before any history has accumulated.
 */

const HOUR_MS = 3_600_000;

export type BurnEstimate = {
  credentialId: string;
  windowType: WindowType;
  /** Inferred as `resetsAt - durationFor(...)`. Null when the provider stated no reset. */
  windowStartsAt: number | null;
  /** Provider-reported units per hour, averaged over the window so far. */
  ratePerHour: number | null;
  /** When this window runs out at that rate, or null when it will not or cannot be said. */
  exhaustsAt: number | null;
  /** Whether the window outlives its own reset. Null only when the estimate is suppressed. */
  survives: boolean | null;
  /**
   * True when the reading must not be extrapolated from; every estimate above
   * is then null. Two ways in: the reading is too old to believe, or it counts
   * a window that has already rolled over. The second is not a kind of the
   * first — such a reading is minutes old — but the consequence is the same,
   * and a surface that phrases them differently asks `quotaRolledOver` itself.
   */
  stale: boolean;
};

export type BurnInput = {
  /** Used for the staleness verdict and nothing else. See the note below. */
  now: number;
  pollIntervalMs: number;
};

/** Where the window began, or null when the provider named no reset to count back from. */
export function windowStartOf(window: QuotaWindow): number | null {
  if (window.resetsAt === null) return null;
  return window.resetsAt - durationFor(window.windowType, window.windowMs);
}

const suppressed = (window: QuotaWindow): BurnEstimate => ({
  credentialId: window.credentialId,
  windowType: window.windowType,
  windowStartsAt: null,
  ratePerHour: null,
  exhaustsAt: null,
  survives: null,
  stale: true,
});

/**
 * The estimate for one window.
 *
 * `now` appears exactly once, in the staleness check. It is deliberately absent
 * from every denominator and from the projection: `used` is the provider's
 * count as of `observedAt`, so the elapsed span is measured to that same
 * instant and `exhaustsAt` is projected from it. Anchoring either to `now`
 * would freeze the numerator between probes while the denominator kept growing,
 * and the console — which refetches every ten seconds against a five-minute
 * poll — would render a sawtooth that is entirely artifact.
 */
export function burnFor(window: QuotaWindow, input: BurnInput): BurnEstimate {
  // A reading of zero is a row written before snapshots existed: never
  // observed, which is not a reading to extrapolate from either.
  if (window.observedAt <= 0) return suppressed(window);
  if (input.now - window.observedAt > quotaStaleAfterMs(input.pollIntervalMs)) {
    return suppressed(window);
  }
  // A window whose own reset is behind us. Nothing below can tell: the poller
  // overwrites the row and nothing else does, so for up to one poll interval
  // after a rollover this counts a window that has ended, and `windowStartOf`
  // still counts back from `resetsAt` to give a start, a span and a rate that
  // all look ordinary. The router has always dropped these.
  //
  // Where it starts is kept, and only the inference is dropped. That instant is
  // a restatement of `resetsAt` and the window's own length, true of the ended
  // window as much as of a live one, and it is what the console charts the
  // retained readings against — readings that were measured and stay measured.
  // The rate, the exhaustion instant and the verdict are claims about a window
  // still being spent, and there is no longer one.
  if (quotaRolledOver(window, input.now)) {
    return {
      ...suppressed(window),
      windowStartsAt: windowStartOf(window),
    };
  }

  const windowStartsAt = windowStartOf(window);
  const elapsedMs = windowStartsAt === null ? null : window.observedAt - windowStartsAt;
  const elapsedHours = elapsedMs === null ? null : elapsedMs / HOUR_MS;

  // No inferred start means no rate. Not zero — unknown: reporting a window we
  // cannot place as idle would read as good news.
  const ratePerHour =
    elapsedHours === null
      ? null
      : elapsedHours <= 0 || window.used === 0
        ? 0
        : window.used / elapsedHours;

  const exhaustsAt =
    window.limit === null || ratePerHour === null || ratePerHour <= 0
      ? null
      : // A window already at or past its ceiling is empty now rather than at
        // some instant in the past.
        window.observedAt + (Math.max(0, window.limit - window.used) / ratePerHour) * HOUR_MS;

  return {
    credentialId: window.credentialId,
    windowType: window.windowType,
    windowStartsAt,
    ratePerHour,
    exhaustsAt,
    survives: exhaustsAt === null || window.resetsAt === null || exhaustsAt >= window.resetsAt,
    stale: false,
  };
}

/**
 * The estimate for a set of snapshot windows.
 *
 * Pure and synchronous, and deliberately so: this rides
 * `/api/credentials/health`, which the console refetches every ten seconds
 * against the same connection that serves inference. Nothing here may read a
 * table. The gateway-rate corroboration that used to be attached here now lives
 * on the history endpoint, which is fetched once per expanded row and scoped to
 * one credential.
 */
export function burnEstimates(windows: readonly QuotaWindow[], input: BurnInput): BurnEstimate[] {
  return windows.map((window) => burnFor(window, input));
}
