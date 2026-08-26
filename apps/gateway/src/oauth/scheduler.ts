import { type Refresher, SCHEDULER_REFRESH_LEAD_MS } from "@omni/control";
import { describeError, GatewayError, type Logger, noopLogger } from "@omni/ir";
import type { CredentialView, Store } from "@omni/store";
import type { Invalidator } from "../stream/broadcaster.ts";

/**
 * How often the sweep runs. Shorter than the scheduler's refresh lead, so a
 * token cannot slip between two sweeps that both judged it healthy.
 */
export const SWEEP_INTERVAL_MS = 60_000;

export type SchedulerDeps = {
  store: Store;
  refresh: Refresher;
  now: () => number;
  logger?: Logger;
  /** Told after a sweep that moved a credential. Absent in most tests. */
  broadcaster?: Invalidator;
};

/** OAuth credentials that are enabled and inside the refresh lead. */
export function due(credentials: readonly CredentialView[], now: number): CredentialView[] {
  return credentials.filter(
    (c) =>
      c.enabled &&
      c.authType === "oauth" &&
      c.expiresAt !== null &&
      c.expiresAt - SCHEDULER_REFRESH_LEAD_MS <= now,
  );
}

/**
 * Refreshes every credential that is close to expiring.
 *
 * Exported so a test can run one sweep without a timer. Returns the number of
 * credentials it successfully refreshed.
 */
export async function sweep(deps: SchedulerDeps): Promise<number> {
  const logger = deps.logger ?? noopLogger;
  const credentials = await deps.store.credentials.list();
  let refreshed = 0;
  /**
   * Rows this sweep moved, which is not the same count as `refreshed`.
   *
   * A credential switched off for having expired with nothing to refresh from
   * is a change the accounts board renders — arguably the one an operator most
   * needs to see — and it never reaches the refresher, so counting only
   * refreshes would leave that board showing an enabled credential until its
   * next poll.
   */
  let touched = 0;

  for (const credential of due(credentials, deps.now())) {
    // Nothing to refresh from and already past its lead: this credential can
    // only be revived by reconnecting, and leaving it enabled costs one failed
    // attempt on every request that picks it.
    if (!credential.hasRefreshToken) {
      if (credential.expiresAt !== null && credential.expiresAt <= deps.now()) {
        await deps.store.credentials.update(credential.id, {
          enabled: false,
          disabledReason: "expiredNoRefresh",
          disabledAt: deps.now(),
        });
        touched += 1;
      }
      continue;
    }

    try {
      // The refresher coalesces per credential, so a sweep that overlaps a live
      // request's refresh shares its result rather than racing it. That matters
      // for providers that rotate the refresh token on every exchange.
      await deps.refresh(credential);
      refreshed += 1;
      touched += 1;
    } catch (error) {
      // An AUTH failure has already disabled the credential and recorded why,
      // inside the refresher. Anything else is transient: leave the credential
      // alone and try again next sweep. The interval is the rate limiter, so
      // there is no backoff to keep here.
      const code = error instanceof GatewayError ? error.code : "INTERNAL";
      // An AUTH failure is a change even though nothing here wrote it: the
      // refresher disabled the credential and recorded the reason before
      // throwing, and a credential going dark is the state an operator most
      // needs the accounts board to show. Anything else left the row alone.
      if (code === "AUTH") touched += 1;
      logger.warn("scheduled token refresh failed", {
        provider: credential.provider,
        credentialId: credential.id,
        code,
        reason: describeError(error, "unknown"),
      });
    }
  }

  // Once for the sweep, and only when it moved something. This runs every
  // minute and most minutes have nothing due, so an unconditional invalidation
  // would be a console refetch a minute for the entire life of every install
  // holding an OAuth credential — no better than the poll it replaces, and
  // paid for by every install rather than by the open tab.
  if (touched > 0) deps.broadcaster?.invalidate("res:credentials");

  return refreshed;
}

/** Starts the sweep. Returns a function that stops it. */
export function startRefreshScheduler(deps: SchedulerDeps): () => void {
  const logger = deps.logger ?? noopLogger;
  let running = false;

  const timer = setInterval(() => {
    // A sweep that outlives its interval must not have a second one started on
    // top of it: two concurrent sweeps would each read the same pre-refresh
    // credential list.
    if (running) return;
    running = true;
    void sweep(deps)
      .catch((error: unknown) => {
        logger.error("token refresh sweep failed", {
          reason: describeError(error, "unknown"),
        });
      })
      .finally(() => {
        running = false;
      });
  }, SWEEP_INTERVAL_MS);

  timer.unref?.();

  return () => clearInterval(timer);
}
