import { type PollerDeps, poll } from "@omni/control";
import { describeError, noopLogger } from "@omni/ir";

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
export async function startQuotaPoller(deps: PollerDeps): Promise<() => void> {
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
