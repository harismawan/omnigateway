import { type PollerDeps, poll } from "@omni/control";

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
  const { quotaPollIntervalMs } = await deps.store.config.getSettings();
  if (quotaPollIntervalMs <= 0) return () => {};

  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void poll(deps)
      .catch((error: unknown) => {
        console.error("quota poll failed", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      })
      .finally(() => {
        running = false;
      });
  }, quotaPollIntervalMs);

  timer.unref?.();

  return () => clearInterval(timer);
}
