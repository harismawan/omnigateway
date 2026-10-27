/**
 * The process-wide ceiling on bytes held for body capture.
 *
 * Every collector reserves against one of these as bytes arrive — the client
 * request text, each wire body, every response chunk and client frame — and
 * gives its reservation back once the body is written or the capture is
 * abandoned. A reservation that does not fit is refused, never waited for: the
 * caller abandons that request's capture and the client's bytes go on exactly
 * as they would have. Back-pressure here would turn an opt-in forensic feature
 * into a latency bug for every captured request at once.
 *
 * A plain counter, because capture is main-thread code and nothing reserves
 * from anywhere else. Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Memory and the request path*, §1).
 */
export type CaptureBudget = {
  /** Holds `bytes` if they fit under the limit and says whether they did; a refusal holds nothing. */
  reserve(bytes: number): boolean;
  /** Gives back bytes an earlier `reserve` took. */
  release(bytes: number): void;
  /** Bytes reserved and not yet released. */
  held(): number;
};

export function createCaptureBudget(limitBytes: number): CaptureBudget {
  let held = 0;
  return {
    reserve(bytes) {
      if (held + bytes > limitBytes) return false;
      held += bytes;
      return true;
    },
    release(bytes) {
      // Floored rather than trusted: a double release is a bug, and a negative
      // count would hand the next request budget that does not exist.
      held = Math.max(0, held - bytes);
    },
    held: () => held,
  };
}
