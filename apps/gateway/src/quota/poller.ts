import { type PollerDeps, poll } from "@omni/control";
import { describeError, noopLogger } from "@omni/ir";
import type { Invalidator } from "../stream/broadcaster.ts";

/**
 * The pass's own dependencies, plus the one thing only a long-lived process has.
 *
 * `PollerDeps` belongs to `@omni/control`, which knows nothing about a caller
 * and must not learn that a socket exists — so the broadcaster is added here
 * rather than there, and `poll` never sees it.
 */
export type QuotaPollerDeps = PollerDeps & { broadcaster?: Invalidator };

/**
 * Starts the poll loop at the interval in settings.
 *
 * The interval is read once at boot: changing it takes effect on restart, which
 * matches how the other startup-time knobs behave. An interval of zero disables
 * polling entirely and arms no timer at all.
 *
 * The pass itself lives in `@omni/control` so the CLI can run one without a
 * timer; what stays here is the part that only a long-lived process wants.
 */
export async function startQuotaPoller(deps: QuotaPollerDeps): Promise<() => void> {
  const logger = deps.logger ?? noopLogger;
  const { quotaPollIntervalMs } = await deps.store.config.getSettings();
  if (quotaPollIntervalMs <= 0) return () => {};

  let running = false;
  const pass = (): void => {
    if (running) return;
    running = true;
    void poll(deps)
      .catch((error: unknown) => {
        logger.error("quota poll failed", {
          reason: describeError(error, "unknown"),
        });
      })
      .finally(() => {
        running = false;
        // When the pass has finished, never when it starts. A `res:quota` sent
        // at the top would have the console refetch readings the probes have
        // not written yet: it would render the *previous* pass's numbers and
        // then go quiet until the next interval, so every chart would sit one
        // whole poll interval — five minutes by default — behind the database.
        //
        // Sent whether the pass threw or not. A pass that failed on its third
        // credential still wrote what the first two returned, and `res:quota`
        // is floored at five seconds, so the cost of a pass that wrote nothing
        // is one frame the console answers with one fetch.
        deps.broadcaster?.invalidate("res:quota");
      });
  };

  // Once at startup, before the first interval elapses. A process that restarts
  // more often than the interval — a watched dev server, a container that
  // cycles, a unit with Restart=on-failure — would otherwise never poll, and
  // its quota would read permanently stale while every probe worked fine.
  // Started rather than awaited: boot does not wait on a provider.
  pass();

  const timer = setInterval(pass, quotaPollIntervalMs);

  timer.unref?.();

  return () => clearInterval(timer);
}
