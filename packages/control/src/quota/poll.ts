import type { Coord } from "@omni/coord";
import {
  describeError,
  type ErrorCode,
  GatewayError,
  type Logger,
  noopLogger,
  type ProviderId,
} from "@omni/ir";
import type { HttpClient } from "@omni/providers";
import type { CredentialView, QuotaWindow, Store } from "@omni/store";
import { SCHEDULER_REFRESH_LEAD_MS } from "../oauth/lead.ts";
import type { Refresher } from "../oauth/refresh.ts";
import type { OAuthProvider } from "../oauth/types.ts";

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
 * Where a credential's probe cooldown lives: `quota:cooldown:<id>`.
 *
 * Behind `coord.kv` with the cooldown as its TTL, so every process polling the
 * same account honours a 429 one of them received, and nothing outlives the
 * cooldown itself — a poller that came up refusing to read accounts for
 * reasons it could no longer explain would be worse than none.
 */
const COOLDOWN_PREFIX = "quota:cooldown:";

/**
 * Where one account's probe is serialised across processes:
 * `quota:probe:<id>`.
 *
 * Per account, never global: a global lock would put every provider behind one
 * queue and undo the four-worker sweep. Holding it is how a second replica
 * asked for the same account finds the first one's reading already written
 * instead of making the same call again.
 */
const PROBE_LOCK_PREFIX = "quota:probe:";

/** How long a lock survives a holder that never returns. */
const PROBE_LOCK_TTL_MS = 60_000;

/** How long a waiter queues before giving up and probing unlocked. */
const PROBE_LOCK_WAIT_MS = 30_000;

/** What one account's refresh is asked for. Bulk is explicit; absence never means all. */
export type QuotaRefreshRequest = { kind: "one"; credentialId: string } | { kind: "all" };

/**
 * Why one account did or did not produce a fresh reading.
 *
 * Host-authored kinds and a closed `ErrorCode`, never upstream or plugin text —
 * the detail behind a failure stays in the structured log. `coalesced` is a
 * success for summaries and stays distinguishable for tests and diagnostics:
 * another overlapping attempt produced the reading this request is answered
 * with.
 */
export type QuotaRefreshOutcome =
  | { kind: "refreshed"; credentialId: string; windows: number }
  | { kind: "noData"; credentialId: string }
  | { kind: "cooldown"; credentialId: string }
  | { kind: "unsupported"; credentialId: string }
  | { kind: "disabled"; credentialId: string }
  | { kind: "failed"; credentialId: string; code: ErrorCode }
  | { kind: "coalesced"; credentialId: string; windows: number };

export type QuotaRefreshResult = { outcomes: QuotaRefreshOutcome[] };

/**
 * An attempt's outcome plus whether this caller is the one that wrote it.
 *
 * The scheduled sweep counts writes, and two callers sharing one in-flight
 * probe both receive its result — so the flag, not the kind, is what keeps a
 * coalesced reading from being counted twice.
 */
type Attempt = { outcome: QuotaRefreshOutcome; wrote: boolean };

export type PollerDeps = {
  store: Store;
  /** Where probe cooldowns live; shared by every process polling this install. */
  coord: Coord;
  providers: Readonly<Partial<Record<ProviderId, OAuthProvider>>>;
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
  if (provider?.usage === undefined) return null;

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
      // Only the provider knows how long its window runs; null says it did not
      // say, and readers fall back to the nominal length of `windowType`.
      windowMs: w.windowMs,
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

/** Runs `job` over `items` at the sweep's width, keeping results in input order. */
async function inOrder<T, R>(
  items: readonly T[],
  job: (item: T) => Promise<R>,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await job(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()));
  return results;
}

/**
 * The scheduled sweep and manual refresh over one shared account attempt.
 *
 * One instance per process, because the in-flight map is what makes a manual
 * request and the sweep that is already probing the same account one provider
 * call rather than two. Two instances coordinate through `coord` instead, which
 * is the weaker guarantee — it suppresses a duplicate *successful* call, and a
 * failed or empty one may repeat.
 */
export type QuotaOps = {
  /** One sweep. Returns how many credentials produced a snapshot. */
  poll(): Promise<number>;
  /** Refreshes on demand. One outcome per account considered, in list order. */
  refresh(request: QuotaRefreshRequest): Promise<QuotaRefreshResult>;
};

export function quotaOps(deps: PollerDeps): QuotaOps {
  const logger = deps.logger ?? noopLogger;
  /**
   * Probes running right now in this process, by credential.
   *
   * Separate from the OAuth refresher's map on purpose: that one protects token
   * rotation, this one protects the usage call. Dropped in `finally`, so a
   * failure or an empty report is retryable immediately rather than being
   * remembered as the account's answer.
   */
  const inFlight = new Map<string, Promise<Attempt>>();

  /**
   * Runs one coordinator call, answering `fallback` if the coordinator is down.
   *
   * `kv` does not fail open on its own — the Redis implementation answers an
   * outage by throwing `OVERLOADED` — and an unreachable coordinator must cost
   * a duplicate provider call, never the refresh itself. Without this a Redis
   * blip turned a bulk refresh into one rejected request instead of a page of
   * outcomes, because `Promise.all` propagates the first rejection.
   */
  async function coordinated<T>(credential: CredentialView, fallback: T, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (error) {
      logger.warn("quota probe coordination unavailable", {
        provider: credential.provider,
        credentialId: credential.id,
        coordFallback: true,
        reason: describeError(error, "unknown"),
      });
      return fallback;
    }
  }

  /** Reports a probe failure without letting the upstream text past the boundary. */
  function reportFailure(credential: CredentialView, error: unknown): ErrorCode {
    const rateLimited = error instanceof GatewayError && error.code === "RATE_LIMIT";
    // A failed probe leaves the previous snapshot in place. The console
    // reports it as ageing rather than as an outage, which is what it is.
    logger.warn(rateLimited ? "quota probe rate limited" : "quota probe failed", {
      provider: credential.provider,
      credentialId: credential.id,
      code: error instanceof GatewayError ? error.code : "INTERNAL",
      ...(rateLimited ? { retryAfterMs: RATE_LIMIT_COOLDOWN_MS } : {}),
      reason: describeError(error, "unknown"),
    });
    return error instanceof GatewayError ? error.code : "INTERNAL";
  }

  /** Probes once, converting every ending into an outcome. Never throws. */
  async function runProbe(credential: CredentialView): Promise<Attempt> {
    const credentialId = credential.id;
    try {
      const rows = await probe(deps, credential);
      if (rows === null) return { outcome: { kind: "noData", credentialId }, wrote: false };
      return { outcome: { kind: "refreshed", credentialId, windows: rows.length }, wrote: true };
    } catch (error) {
      if (error instanceof GatewayError && error.code === "RATE_LIMIT") {
        // A cooldown that cannot be recorded costs a repeated call at the next
        // pass; letting it escape would lose the 429 outcome entirely.
        await coordinated(credential, undefined, () =>
          deps.coord.kv.set(COOLDOWN_PREFIX + credentialId, "1", RATE_LIMIT_COOLDOWN_MS),
        );
      }
      return {
        outcome: { kind: "failed", credentialId, code: reportFailure(credential, error) },
        wrote: false,
      };
    }
  }

  /**
   * Probes under the account's lock, unless another replica already answered.
   *
   * `startedAt` is read before the wait, so a reading written while this call
   * queued counts as the answer to it. Only a successful attempt leaves that
   * evidence; a failed or empty one has nothing to reread, and repeating it is
   * the cost of not persisting a marker for every outcome.
   */
  async function runGuarded(credential: CredentialView, startedAt: number): Promise<Attempt> {
    const credentialId = credential.id;
    let entered = false;

    const body = async (): Promise<Attempt> => {
      entered = true;
      const rows = (await deps.store.credentials.listQuota()).filter(
        (row) => row.credentialId === credentialId,
      );
      if (rows.some((row) => row.observedAt >= startedAt)) {
        return { outcome: { kind: "coalesced", credentialId, windows: rows.length }, wrote: false };
      }
      return runProbe(credential);
    };

    try {
      return await deps.coord.mutex.withLock(
        PROBE_LOCK_PREFIX + credentialId,
        PROBE_LOCK_TTL_MS,
        PROBE_LOCK_WAIT_MS,
        body,
      );
    } catch (error) {
      // `body` answers every ending itself, so a throw here is the lock and not
      // the probe. Telemetry an operator asked for is worth more than the
      // guarantee that no sibling replica asks the provider twice.
      if (entered)
        return { outcome: { kind: "failed", credentialId, code: "INTERNAL" }, wrote: false };
      logger.warn("quota probe lock unavailable", {
        provider: credential.provider,
        credentialId,
        coordFallback: true,
        reason: describeError(error, "unknown"),
      });
      return runProbe(credential);
    }
  }

  /**
   * One account, whole policy: eligibility, cooldown, coalescing, probe.
   *
   * Eligibility is decided before anything opens a secret or calls a provider,
   * and the cooldown is read before the lock — a rate-limited endpoint must not
   * be queued for, only skipped.
   */
  function attempt(credential: CredentialView): Promise<Attempt> {
    const credentialId = credential.id;
    if (!credential.enabled) {
      return Promise.resolve({ outcome: { kind: "disabled", credentialId }, wrote: false });
    }
    if (
      credential.authType !== "oauth" ||
      deps.providers[credential.provider]?.usage === undefined
    ) {
      return Promise.resolve({ outcome: { kind: "unsupported", credentialId }, wrote: false });
    }

    const running = inFlight.get(credentialId);
    if (running !== undefined) {
      // The waiter shares the call but not the credit for it: whatever the
      // holder wrote, this request did not write it.
      return running.then((shared) =>
        shared.outcome.kind === "refreshed"
          ? {
              outcome: {
                kind: "coalesced" as const,
                credentialId,
                windows: shared.outcome.windows,
              },
              wrote: false,
            }
          : { outcome: shared.outcome, wrote: false },
      );
    }

    const startedAt = deps.now();
    const started = (async (): Promise<Attempt> => {
      // Null on an unreachable coordinator: unknown is not "cooling down", and
      // refusing to probe because the cooldown could not be read would make a
      // coordinator outage look like every account being rate limited.
      const cooling = await coordinated(credential, null, () =>
        deps.coord.kv.get(COOLDOWN_PREFIX + credentialId),
      );
      if (cooling !== null) {
        return { outcome: { kind: "cooldown", credentialId }, wrote: false };
      }
      return runGuarded(credential, startedAt);
    })();

    // Installed before yielding, so a caller arriving during the probe finds it.
    inFlight.set(credentialId, started);
    return started.finally(() => {
      inFlight.delete(credentialId);
    });
  }

  return {
    async poll(): Promise<number> {
      const credentials = await deps.store.credentials.list();
      const attempts = await inOrder(credentials, attempt);
      return attempts.filter((a) => a?.wrote === true).length;
    },

    async refresh(request: QuotaRefreshRequest): Promise<QuotaRefreshResult> {
      if (request.kind === "one") {
        const credentialId = request.credentialId.trim();
        if (credentialId === "") throw new GatewayError("BAD_REQUEST", "no such credential");
        const credential = await deps.store.credentials.get(credentialId);
        if (credential === null) throw new GatewayError("BAD_REQUEST", "no such credential");
        return { outcomes: [(await attempt(credential)).outcome] };
      }

      const credentials = await deps.store.credentials.list();
      const attempts = await inOrder(credentials, attempt);
      const outcomes: QuotaRefreshOutcome[] = [];
      for (const [index, credential] of credentials.entries()) {
        // A worker cannot leave a hole — `inOrder` fills every slot it visits —
        // but the type says it can, and inventing an outcome would be worse
        // than naming the account the sweep could not account for.
        const result = attempts[index];
        outcomes.push(
          result?.outcome ?? { kind: "failed", credentialId: credential.id, code: "INTERNAL" },
        );
      }
      return { outcomes };
    },
  };
}

/**
 * Probes every enabled OAuth credential whose provider exposes usage.
 *
 * Exported so a test can run one pass without a timer. Returns how many
 * credentials produced a snapshot. A caller that also serves manual refreshes
 * wants `quotaOps` instead, and to hold the one instance: this builds a fresh
 * in-flight map per call, so it shares nothing with anybody.
 */
export async function poll(deps: PollerDeps): Promise<number> {
  return quotaOps(deps).poll();
}
