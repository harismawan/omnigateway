import type { Logger } from "@omni/ir";
import { describeError } from "@omni/ir";

export type ShutdownMode = "graceful" | "force";

/** Stops this gateway. Safe to call more than once; the second call escalates. */
export type Shutdown = (reason: string, mode?: ShutdownMode) => void;

export type ShutdownDeps = {
  logger: Logger;
  /**
   * The background loops, in the order they were started.
   *
   * Stopped before the server is, because a timer that fires while the socket
   * is draining reaches a store that is about to close.
   */
  stopLoops: readonly (() => void)[];
  stopServer: () => Promise<void>;
  closeStore: () => void;
  /** `process.exit` in the gateway, and a recorder in a test. */
  exit: (code: number) => void;
  /** How long connections have to drain before the process leaves anyway. */
  stopDeadlineMs?: number;
};

/**
 * How long a draining server has before it is abandoned.
 *
 * Bun stops a server by letting its connections finish, and a shutdown asked
 * for over HTTP arrives on one of them: the request that requested the
 * shutdown is itself a reason the shutdown cannot complete. The gateway used
 * to answer `ok` and then stay up until a second signal escalated. So the wait
 * is bounded, and the exit is clean when it expires — a nonzero code here would
 * be read by `Restart=on-failure` as a crash and bring back the process an
 * operator just asked to stop.
 */
const STOP_DEADLINE_MS = 5_000;

/**
 * The one way this process stops, whoever asked.
 *
 * Signals and the lifecycle route both arrive here. They used to be unable to:
 * the server, the store, and the three loop stoppers are locals of the
 * bootstrap, so a handler defined anywhere else had nothing to stop. Closing
 * over them once and handing the result to both callers is what makes a
 * shutdown from the dashboard the same shutdown as a `SIGTERM`.
 *
 * The escalation rule is the one an operator already relies on: a second
 * request while the first is still draining stops waiting and goes, with a
 * failure code, because the first one is evidently stuck.
 */
export function createShutdown(deps: ShutdownDeps): Shutdown {
  let shuttingDown = false;

  const exitAfterClosingStore = (code: number): void => {
    try {
      deps.closeStore();
    } finally {
      deps.exit(code);
    }
  };

  return (reason, mode = "graceful") => {
    if (mode === "force" || shuttingDown) {
      exitAfterClosingStore(1);
      return;
    }

    deps.logger.info("shutdown requested", { reason });
    shuttingDown = true;
    for (const stop of deps.stopLoops) stop();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const abandoned = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), deps.stopDeadlineMs ?? STOP_DEADLINE_MS);
      timer.unref?.();
    });

    void Promise.race([deps.stopServer(), abandoned]).then(
      (outcome) => {
        clearTimeout(timer);
        if (outcome === "timeout") {
          deps.logger.warn("shutdown timed out waiting for connections to drain", { reason });
        }
        exitAfterClosingStore(0);
      },
      (error: unknown) => {
        clearTimeout(timer);
        deps.logger.error("shutdown failed", {
          reason: describeError(error, "unknown"),
        });
        exitAfterClosingStore(1);
      },
    );
  };
}

/**
 * How long the answer has to reach the client before the process stops.
 *
 * A shutdown that took the socket with it would be indistinguishable from a
 * dropped connection, and a dashboard cannot tell an operator that a thing they
 * asked for worked if the evidence left with it.
 */
export const RESPONSE_FLUSH_MS = 100;

/**
 * The stop effect `@omni/control`'s lifecycle operations are handed.
 *
 * The package documents that this must defer — it has an HTTP response to
 * flush and timers are not its to own — so the deferral lives here, where the
 * response and the process both do.
 */
export function createDeferredStop(
  shutdown: Shutdown,
  delayMs: number = RESPONSE_FLUSH_MS,
): (exitCode: number) => void {
  return (exitCode) => {
    const timer = setTimeout(() => {
      shutdown("api", exitCode === 0 ? "graceful" : "force");
    }, delayMs);
    // Nothing should be kept alive *by* a pending shutdown.
    timer.unref?.();
  };
}
