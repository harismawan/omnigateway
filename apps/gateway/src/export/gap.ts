import type { Settings } from "@omni/store/types";

/**
 * The gap warning: rows may have been pruned before this destination sent
 * them. Pure. Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Cursor* → Retention, Retention changes).
 *
 * A flag, never a count. The worker compares the destination's **effective
 * position** `E = max(cursor_at, caught_up_through)` with the prune horizon
 * `H = now − logRetentionDays`; a row is lost only if it was deleted (`at < H`)
 * while unsent (`completed_at > E`), and for any request shorter than 24 h that
 * implies `E < H + 24 h`. Checked before every batch and on every tick, so a
 * batch can never advance past an unsent deleted row unflagged.
 *
 * Shortening retention jumps `H` forward between two checks, so it is caught
 * separately: `Settings.logRetentionLoweredAt` newer than the
 * `seen_retention_lowered_at` the destination last committed flags it too.
 */

/** Rows completed within this of the database clock are not read yet. */
export const SETTLE_MS = 10_000;

/** How close to the prune horizon a destination may fall before it is flagged. */
export const GAP_MARGIN_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type GapReason = "lag" | "retention-lowered";

export function effectivePosition(s: { cursorAt: number; caughtUpThrough: number }): number {
  return Math.max(s.cursorAt, s.caughtUpThrough);
}

/**
 * Why the destination should be flagged now, or null.
 *
 * `createdAt` floors the retention marker: a shortening that happened before
 * the destination existed cannot have pruned anything it owed — rows older
 * than retention were never exportable — and a fresh state row starts at
 * `seen = 0`, so without the floor every destination created on an install
 * that ever shortened retention would be flagged on its first tick.
 */
export function gapReason(
  state: { cursorAt: number; caughtUpThrough: number; seenRetentionLoweredAt: number },
  settings: Pick<Settings, "logRetentionDays" | "logRetentionLoweredAt">,
  now: number,
  createdAt: number,
): GapReason | null {
  const horizon = now - settings.logRetentionDays * DAY_MS;
  if (effectivePosition(state) < horizon + GAP_MARGIN_MS) return "lag";
  if (settings.logRetentionLoweredAt > Math.max(state.seenRetentionLoweredAt, createdAt)) {
    return "retention-lowered";
  }
  return null;
}
