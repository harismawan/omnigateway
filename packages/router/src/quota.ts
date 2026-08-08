import type { CredentialView, QuotaWindow, WindowType } from "@omni/store";

/**
 * How the router reads a quota snapshot.
 *
 * Pure, like the rest of the router: it is handed rows the poller wrote and a
 * clock, and never asks a provider anything.
 */

/** Nominal length of each window, used to judge burn rate against the clock. */
const WINDOW_DURATION_MS: Record<WindowType, number> = {
  fiveHour: 5 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** Neutral score for a credential whose provider reports no usage at all. */
export const UNKNOWN_QUOTA = 0.5;

/**
 * Below this, an account is close enough to exhaustion that a rotation should
 * stop feeding it even though the filter still admits it.
 */
export const QUOTA_FLOOR = 0.1;

/**
 * How old a reading may be before the router stops believing it.
 *
 * The same rule the console uses: three poll intervals. One missed poll is a
 * blip; three in a row means the number describes the past, and routing on a
 * stale reading is worse than routing on none.
 */
export function quotaStaleAfterMs(pollIntervalMs: number): number {
  return Math.max(pollIntervalMs, 60_000) * 3;
}

/**
 * Headroom in one window, judged against how much of the window is left.
 *
 * Raw headroom answers the wrong question. Five percent left is fine when the
 * window resets in two minutes and alarming when it has six days to run, and a
 * router that cannot tell those apart either hoards a window that is about to
 * refill or keeps feeding one that will be spent long before it does.
 *
 * The ratio is headroom over remaining time, both as fractions of the window:
 * at or ahead of pace scores 1, and falling behind scores proportionally less.
 */
function paceAdjusted(window: QuotaWindow, now: number): number {
  const limit = window.limit;
  if (limit === null || limit <= 0) return 1;

  const headroom = Math.max(0, Math.min(1, 1 - window.used / limit));
  if (window.resetsAt === null) return headroom;

  const duration = WINDOW_DURATION_MS[window.windowType];
  // Floored, so the last moments of a window do not divide headroom by nearly
  // zero and read every account as perfect.
  const remaining = Math.max(0.05, Math.min(1, (window.resetsAt - now) / duration));

  return Math.max(0, Math.min(1, headroom / remaining));
}

/**
 * A credential's quota score in 0..1, where 1 is "nothing to worry about".
 *
 * The tightest usable window wins, because that is the one that will block
 * first. A window is usable only if it was actually observed, is recent enough
 * to believe, and has not already rolled over: an exhausted reading past its
 * own reset time describes a window that no longer exists.
 */
export function quotaHeadroom(
  credential: CredentialView,
  windows: readonly QuotaWindow[],
  now: number,
  pollIntervalMs: number,
): number {
  const staleAfter = quotaStaleAfterMs(pollIntervalMs);

  const usable = windows.filter(
    (w) =>
      w.limit !== null &&
      w.limit > 0 &&
      w.observedAt > 0 &&
      now - w.observedAt <= staleAfter &&
      (w.resetsAt === null || w.resetsAt > now),
  );

  if (usable.length === 0) {
    // An api-key credential is billed per token rather than against a
    // subscription window, so having no window is the normal state and not a
    // gap in what we know. An OAuth credential with nothing reported is a gap:
    // scoring it as full headroom would rank an account we know nothing about
    // above one we know has room.
    return credential.authType === "apiKey" ? 1 : UNKNOWN_QUOTA;
  }

  return Math.min(...usable.map((w) => paceAdjusted(w, now)));
}
