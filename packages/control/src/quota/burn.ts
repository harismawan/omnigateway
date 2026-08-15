import { quotaStaleAfterMs } from "@omni/router";
import { durationFor, type QuotaWindow, type Store, type WindowType } from "@omni/store";

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
  /** Tokens per hour this gateway can account for over the same span. */
  gatewayRatePerHour: number | null;
  /** True when the reading is too old to believe; every estimate above is then null. */
  stale: boolean;
};

export type BurnInput = {
  /** Used for the staleness verdict and nothing else. See the note below. */
  now: number;
  pollIntervalMs: number;
  /** Gateway tokens billed to this credential across the same span. */
  gatewayTokens?: number | null;
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
  gatewayRatePerHour: null,
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

  const gatewayTokens = input.gatewayTokens ?? null;
  const gatewayRatePerHour =
    gatewayTokens === null || elapsedHours === null || elapsedHours <= 0
      ? null
      : gatewayTokens / elapsedHours;

  return {
    credentialId: window.credentialId,
    windowType: window.windowType,
    windowStartsAt,
    ratePerHour,
    exhaustsAt,
    survives: exhaustsAt === null || window.resetsAt === null || exhaustsAt >= window.resetsAt,
    gatewayRatePerHour,
    stale: false,
  };
}

export type BurnDeps = { store: Store; now: () => number };

const spanKey = (since: number, until: number) => `${since}:${until}`;

/**
 * The estimate for a set of snapshot windows, with the gateway's own rate
 * attached.
 *
 * The gateway side is one aggregate per distinct span rather than per window:
 * accounts sharing a reset — the common case for one provider polled in one
 * sweep — share a query. Spans come from the readings, not from the clock, so
 * the two rates always cover the same hours and are comparable.
 */
export async function burnEstimates(
  deps: BurnDeps,
  windows: readonly QuotaWindow[],
  pollIntervalMs: number,
): Promise<BurnEstimate[]> {
  const now = deps.now();
  const spans = new Map<string, { since: number; until: number }>();
  for (const window of windows) {
    const since = windowStartOf(window);
    if (since === null || window.observedAt <= since) continue;
    spans.set(spanKey(since, window.observedAt), { since, until: window.observedAt });
  }

  const tokens = new Map<string, number>();
  for (const [key, span] of spans) {
    const rows = await deps.store.usage.aggregate({
      grain: "raw",
      groupBy: "credential",
      since: span.since,
      until: span.until,
    });
    for (const row of rows) {
      // Every class the provider's own counter is charged for. Dropping the
      // cached ones would understate what this gateway accounts for and
      // manufacture a divergence from the provider rate that is not there.
      tokens.set(
        `${key}|${row.key}`,
        row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens,
      );
    }
  }

  return windows.map((window) => {
    const since = windowStartOf(window);
    const gatewayTokens =
      since === null || window.observedAt <= since
        ? null
        : (tokens.get(`${spanKey(since, window.observedAt)}|${window.credentialId}`) ?? 0);
    return burnFor(window, { now, pollIntervalMs, gatewayTokens });
  });
}
