/**
 * How far ahead of expiry a token is refreshed.
 *
 * Two leads, deliberately different. The scheduler sweeps on a background timer
 * and refreshes early, so in normal operation no request ever waits on a token
 * exchange. Dispatch keeps the shorter lead as the safety net for the cases the
 * sweep cannot cover: the gateway just booted, the sweep is disabled, or a
 * token was issued with a lifetime shorter than the sweep interval.
 *
 * The scheduler lead must exceed the sweep interval, or a token can expire
 * between two sweeps that both considered it fine.
 */
export const DISPATCH_REFRESH_LEAD_MS = 120_000;
export const SCHEDULER_REFRESH_LEAD_MS = 300_000;
