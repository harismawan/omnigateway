/**
 * When a destination that failed is tried again. Pure; the randomness is
 * injected. Design: *Delivery* → Retry, Hard failure.
 *
 * 1 s doubling to 5 min, jittered. "Equal jitter": the delay is drawn from the
 * upper half of the step, so retries from several destinations spread out but
 * a destination is never retried sooner than half its step. A receiver's
 * `Retry-After` is honoured up to the same 5 min ceiling and only ever
 * lengthens the wait. A hard failure waits the ceiling.
 */

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 5 * 60 * 1000;

/**
 * The wait before attempt number `failures + 1`, where `failures` counts the
 * consecutive retryable failures so far (1 for the first).
 */
export function retryDelay(
  failures: number,
  retryAfterMs: number | null,
  random: () => number,
): number {
  const exponent = Math.min(Math.max(failures, 1) - 1, 30);
  const step = Math.min(BACKOFF_MIN_MS * 2 ** exponent, BACKOFF_MAX_MS);
  const jittered = Math.round(step / 2 + (step / 2) * random());
  const floor = Math.min(retryAfterMs ?? 0, BACKOFF_MAX_MS);
  return Math.min(Math.max(jittered, floor), BACKOFF_MAX_MS);
}

/**
 * `Retry-After` in ms: delta-seconds or an HTTP date. Null when absent or
 * unreadable; a date in the past is 0. Never quoted anywhere — it is receiver
 * text, read here as a number and nothing else.
 */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) return null;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  if (!/[A-Za-z]/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
