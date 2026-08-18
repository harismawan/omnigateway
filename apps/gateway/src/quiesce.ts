/**
 * The admission gate in front of client traffic while the database is replaced.
 *
 * A restore closes the SQLite handle and moves a file over the one every repo
 * reads from. Requests that were mid-flight when that happens are the reason
 * this exists: they hold a store handle, and a request admitted *after* the
 * close would find one that is not there. So new work is refused with a
 * retryable status, work already admitted is waited for, and the wait is
 * bounded because a swap that never happens is worse than a request that was
 * cut short.
 *
 * It gates `/v1/*` and nothing else. `/api/*` and `/health` stay live for the
 * whole operation: the dashboard is how an operator watches a restore and how
 * they hear it failed, and a latch that took the console down with it would
 * leave them with a half-swapped database and no way to see it.
 */
export type QuiesceLatch = {
  /**
   * Admits one request, or refuses it.
   *
   * Returns the release for the request that was admitted, which the caller
   * must run exactly once — running it twice is a no-op, and never running it
   * costs the next `close` its deadline rather than blocking forever.
   */
  enter(): (() => void) | null;
  /** Whether new work is currently refused. */
  isClosed(): boolean;
  /**
   * Refuses new work, then waits for what is already in flight.
   *
   * Resolves as soon as the last admitted request releases, or at
   * `deadlineMs`, whichever comes first. `drained` says which of the two
   * happened, because a caller about to replace a file underneath those
   * requests should be able to say so in its log.
   */
  close(deadlineMs: number): Promise<{ drained: boolean; inFlight: number }>;
  /** Admits work again. Safe on an already open latch. */
  open(): void;
};

export function createQuiesceLatch(): QuiesceLatch {
  let admitting = true;
  let inFlight = 0;
  /** Set only while a `close` is waiting, and called at most once by it. */
  let onIdle: (() => void) | null = null;

  const settle = (): void => {
    if (inFlight > 0 || onIdle === null) return;
    const resolve = onIdle;
    onIdle = null;
    resolve();
  };

  return {
    enter() {
      if (!admitting) return null;
      inFlight++;
      let released = false;
      return () => {
        // Latched, because a request can reach its release twice: Elysia's
        // after-response hook and an error path both run for the same request.
        if (released) return;
        released = true;
        inFlight--;
        settle();
      };
    },

    isClosed: () => !admitting,

    open() {
      admitting = true;
    },

    async close(deadlineMs) {
      admitting = false;
      if (inFlight === 0) return { drained: true, inFlight: 0 };

      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<void>((resolve) => {
        onIdle = resolve;
      });
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      });
      try {
        await Promise.race([idle, deadline]);
      } finally {
        // Both halves go: an unfired timer would hold the process open, and a
        // stale `onIdle` would be resolved by a request releasing long after
        // the caller that was waiting for it gave up.
        clearTimeout(timer);
        onIdle = null;
      }
      return { drained: inFlight === 0, inFlight };
    },
  };
}
