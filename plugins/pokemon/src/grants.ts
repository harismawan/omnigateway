import type { LimitReached } from "@omni/plugins";

/**
 * A limit window's stable identity.
 *
 * `dimension:window` and nothing else. Never a reset instant or anything else
 * recomputed on each evaluation — a rolling weekly window's reset moves every
 * time it is read, and keying an edge trigger on it re-fires the grant at 80%,
 * then 81%, then 84%, on every refresh. Both this codebase and the app this is
 * ported from have shipped that bug.
 */
export function windowKey(event: Pick<LimitReached, "dimension" | "window">): string {
  return `${event.dimension}:${event.window}`;
}

/**
 * How many candies a window is worth when it fills.
 *
 * A weekly ceiling is a week of work and a short one is an afternoon's burst, so
 * they are not worth the same. The split is by window length rather than by
 * dimension, because what is being rewarded is the span of effort.
 */
export function grantSize(window: LimitReached["window"]): number {
  return window === "1w" ? 5 : 1;
}

export type GrantDecision =
  | { grant: false; seedTo?: number }
  | { grant: true; count: number; tier: number };

/**
 * Decides what a limit event is worth, given what has already been paid.
 *
 * Two rules, and each of them is a bug the source app shipped first.
 *
 * **Edge, not level.** A key sitting at its ceiling reports it on every
 * evaluation. Paying each time turns a rate limit into a faucet, so the stored
 * tier records that this window has already been paid for and only a rise past
 * it pays again.
 *
 * **Seeded on first sight.** Installing the plugin against a key already at its
 * ceiling must not pay out for a window it never watched fill. The first
 * observation of a key records where it stands and pays nothing; every later one
 * is a real edge. Without this, the reward for installing the plugin is a
 * backdated windfall.
 */
export function decideGrant(input: {
  window: LimitReached["window"];
  /** What this window has already paid out, 0 for never. */
  grantedTier: number;
  /** Whether this key has been observed before at all. */
  seeded: boolean;
}): GrantDecision {
  const tier = 1;
  if (!input.seeded) {
    // Record where things stand, pay nothing. `seedTo` is what the caller
    // writes so the same window does not read as an edge next time.
    return { grant: false, seedTo: tier };
  }
  if (input.grantedTier >= tier) return { grant: false };
  return { grant: true, count: grantSize(input.window), tier };
}
