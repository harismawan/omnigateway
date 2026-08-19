import type { LimitReached } from "@omni/plugins";
import { WINDOW_MS } from "@omni/ratelimit/catalog";

/**
 * A limit window's stable identity.
 *
 * `dimension:window` and nothing else. Never a reset instant or anything else
 * recomputed on each evaluation — a rolling weekly window recomputes one every
 * time it is read, and keying on it re-fires the grant at 80%, then 81%, then
 * 84%, on every refresh. Both this codebase and the app this is ported from have
 * shipped exactly that.
 */
export function windowKey(event: Pick<LimitReached, "dimension" | "window">): string {
  return `${event.dimension}:${event.window}`;
}

/**
 * How many candies a window is worth when it fills.
 *
 * A weekly ceiling is a week of work and a short one is an afternoon's burst, so
 * they are not worth the same. Split by span rather than by dimension, because
 * what is being rewarded is the length of the effort.
 */
export function grantSize(window: LimitReached["window"]): number {
  return window === "1w" ? 5 : 1;
}

export type GrantDecision =
  | { grant: false; seedAt?: number }
  | { grant: true; count: number; at: number };

/**
 * Decides what a limit event is worth.
 *
 * **Rate-limited by the window's own length, not edge-triggered on a level.**
 * That is a correction, and the reasoning is worth keeping because the obvious
 * design does not work.
 *
 * The obvious design records that a window has been paid and waits for it to
 * empty before paying again. There is no event for emptying. `LimitReached`
 * fires while a key is at its ceiling and says nothing when it drops, so
 * "already paid" is a latch that never re-arms: the window pays once and then
 * never again for the life of the installation. An integration test caught
 * exactly that, after the unit tests for this file passed.
 *
 * A window cannot legitimately fill more than once per its own duration, so the
 * duration is the rate limit. A `1w` ceiling pays at most weekly, a `1m` ceiling
 * at most once a minute, and a key parked at its limit collects on the same
 * schedule it would have earned anyway.
 *
 * Seeding still applies: the first sighting of a key records the instant and
 * pays nothing, so installing against a key already at its ceiling is not a
 * backdated windfall.
 */
export function decideGrant(input: {
  window: LimitReached["window"];
  /** When this window last paid, or null for never. */
  lastGrantedAt: number | null;
  /** Whether this key has been observed at all. */
  seeded: boolean;
  now: number;
}): GrantDecision {
  if (!input.seeded) return { grant: false, seedAt: input.now };
  if (input.lastGrantedAt !== null && input.now - input.lastGrantedAt < WINDOW_MS[input.window]) {
    return { grant: false };
  }
  return { grant: true, count: grantSize(input.window), at: input.now };
}
