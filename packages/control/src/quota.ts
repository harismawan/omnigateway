import { GatewayError, type Logger, noopLogger, type ProviderId } from "@omni/ir";
import type { HttpClient } from "@omni/providers";
import type { CredentialView, QuotaWindow, Store } from "@omni/store";
import { SCHEDULER_REFRESH_LEAD_MS } from "./oauth/lead.ts";
import type { Refresher } from "./oauth/refresh.ts";
import type { OAuthProvider } from "./oauth/types.ts";

/** Accounts probed at once. Enough to keep the sweep short, few enough to be quiet. */
const CONCURRENCY = 4;

/**
 * How long a credential is left alone after its usage endpoint answers 429.
 *
 * These endpoints are throttled separately from inference, so a 429 here means
 * "stop asking", not "this account is out of quota" — chat on the same token
 * keeps working. Backing off is what stops a short poll interval from turning
 * one rate-limited account into a steady stream of failed probes.
 */
export const RATE_LIMIT_COOLDOWN_MS = 180_000;

/**
 * Credential id to the time its probe may be tried again.
 *
 * Process-local and lost on restart, like the API-key rate limiter. A cooldown
 * that outlived the process would be worse than none: the poller would come up
 * refusing to read accounts for reasons it can no longer explain.
 */
const cooldowns = new Map<string, number>();

/** Test seam: forget every recorded cooldown. */
export function resetQuotaCooldowns(): void {
  cooldowns.clear();
}

export type PollerDeps = {
  store: Store;
  providers: Readonly<Record<ProviderId, OAuthProvider>>;
  http: HttpClient;
  refresh: Refresher;
  now: () => number;
  logger?: Logger;
};

/**
 * Reads one credential's usage and writes it as a snapshot.
 *
 * Returns the rows written, or null when there was nothing to record: an
 * api-key credential, a provider with no probe, or a probe that answered with
 * nothing usable. Never disables a credential — see the note on
 * `OAuthProvider.usage`.
 */
export async function probe(
  deps: PollerDeps,
  credential: CredentialView,
): Promise<QuotaWindow[] | null> {
  if (credential.authType !== "oauth") return null;
  const provider = deps.providers[credential.provider];
  if (provider.usage === undefined) return null;

  // A probe with a stale token would read as an auth failure and report
  // nothing, so refresh first on the same lead the scheduler uses.
  const refreshed =
    credential.hasRefreshToken &&
    credential.expiresAt !== null &&
    credential.expiresAt - SCHEDULER_REFRESH_LEAD_MS <= deps.now()
      ? await deps.refresh(credential)
      : null;
  const secrets =
    refreshed === null ? await credential.openForUsage() : { accessToken: refreshed.accessToken };

  const report = await provider.usage(
    secrets,
    { http: deps.http, now: deps.now },
    credential.providerData,
  );
  if (report === null || report.windows.length === 0) return null;

  const observedAt = deps.now();
  const rows = report.windows.map(
    (w): QuotaWindow => ({
      credentialId: credential.id,
      windowType: w.windowType,
      // The provider reports where the window ends, not where it began; the
      // observation time is the honest lower bound for a window we are seeing
      // mid-flight.
      startsAt: observedAt,
      used: w.used,
      limit: w.limit,
      resetsAt: w.resetsAt,
      observedAt,
    }),
  );

  await deps.store.credentials.saveQuota(rows);
  (deps.logger ?? noopLogger).debug("quota snapshot written", {
    provider: credential.provider,
    credentialId: credential.id,
    count: rows.length,
  });
  return rows;
}

/**
 * Probes every enabled OAuth credential whose provider exposes usage.
 *
 * Exported so a test can run one pass without a timer. Returns how many
 * credentials produced a snapshot.
 */
export async function poll(deps: PollerDeps): Promise<number> {
  const logger = deps.logger ?? noopLogger;
  const now = deps.now();
  const credentials = (await deps.store.credentials.list()).filter(
    (c) =>
      c.enabled &&
      c.authType === "oauth" &&
      deps.providers[c.provider].usage !== undefined &&
      (cooldowns.get(c.id) ?? 0) <= now,
  );

  let written = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < credentials.length) {
      const credential = credentials[next++];
      if (credential === undefined) return;
      try {
        if ((await probe(deps, credential)) !== null) written += 1;
      } catch (error) {
        const rateLimited = error instanceof GatewayError && error.code === "RATE_LIMIT";
        if (rateLimited) {
          cooldowns.set(credential.id, deps.now() + RATE_LIMIT_COOLDOWN_MS);
        }
        // A failed probe leaves the previous snapshot in place. The console
        // reports it as ageing rather than as an outage, which is what it is.
        logger.warn(rateLimited ? "quota probe rate limited" : "quota probe failed", {
          provider: credential.provider,
          credentialId: credential.id,
          code: error instanceof GatewayError ? error.code : "INTERNAL",
          ...(rateLimited ? { retryAfterMs: RATE_LIMIT_COOLDOWN_MS } : {}),
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, credentials.length) }, () => worker()),
  );
  return written;
}
