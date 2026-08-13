import { DISPATCH_REFRESH_LEAD_MS } from "@omni/control";
import {
  type ChatRequest,
  GatewayError,
  HTTP_STATUS,
  type Logger,
  noopLogger,
  type ProviderId,
  RETRYABLE,
  type StreamEvent,
} from "@omni/ir";
import type { HttpClient, ProviderAdapter } from "@omni/providers";
import {
  blankHealth,
  type Candidate,
  healthKey,
  rank,
  recordFailure,
  recordSuccess,
  resolveModel,
} from "@omni/router";
import { transformRequest } from "@omni/rtk";
import type {
  CredentialSecrets,
  CredentialView,
  RequestLog,
  Store,
  VirtualModel,
} from "@omni/store";
import { newCompletedRequestLog } from "../logging.ts";
import { attempt } from "./attempt.ts";
import { classify } from "./classify.ts";
import type { LoadRegistry } from "./loadRegistry.ts";
import { priceOf } from "./price.ts";
import type { RoutingSnapshotSource } from "./snapshotCache.ts";

export type DispatchDeps = {
  store: Store;
  snapshots: RoutingSnapshotSource;
  adapters: Readonly<Partial<Record<ProviderId, ProviderAdapter>>>;
  /** Order-preserving transport. Never globalThis.fetch — see Global Constraints. */
  http: HttpClient;
  now: () => number;
  rand: () => number;
  /** In-flight accounting, so ranking can see a burst that has not finished yet. */
  loadRegistry: LoadRegistry;
  refresh: (credential: CredentialView) => Promise<CredentialSecrets>;
  logger?: Logger;
  /** Called when an attempt selects its target, before outbound work starts. */
  onRoute?: (target: {
    provider: ProviderId;
    model: string;
    credentialId: string;
  }) => Promise<void>;
};

export type DispatchOutcome = {
  events: AsyncGenerator<StreamEvent, void, undefined>;
  /** Valid once the stream is drained. Egress writes it to the usage repo. */
  log: () => RequestLog;
};

export async function dispatch(
  request: ChatRequest,
  deps: DispatchDeps,
  signal: AbortSignal,
  requestId: string,
): Promise<DispatchOutcome> {
  const logger = deps.logger ?? noopLogger;
  const startedAt = deps.now();
  const snapshot = await deps.snapshots.get(startedAt);
  const deadlineAt =
    snapshot.settings.requestDeadlineMs === 0
      ? null
      : startedAt + snapshot.settings.requestDeadlineMs;

  // Dispatch only ever hands back a finished log; the pending row the console
  // watches is written by the route, before this runs.
  const log: RequestLog = newCompletedRequestLog(requestId, startedAt, {
    requestedModel: request.model,
    // Dispatch assigns the terminal HTTP status before exposing this log.
    status: 0,
  });

  let dispatchRequest = request;

  const fail = (code: GatewayError["code"], message: string): DispatchOutcome => {
    log.errorCode = code;
    log.status = HTTP_STATUS[code];
    log.durationMs = deps.now() - startedAt;
    return {
      events: (async function* () {
        yield { type: "error", code, message, retryable: RETRYABLE[code] } as StreamEvent;
      })(),
      log: () => log,
    };
  };

  const dispatchController = new AbortController();
  const abortFromClient = () => dispatchController.abort(signal.reason);
  if (signal.aborted) abortFromClient();
  else signal.addEventListener("abort", abortFromClient, { once: true });
  const deadlineTimer =
    deadlineAt === null
      ? null
      : setTimeout(
          () => dispatchController.abort(new GatewayError("TIMEOUT", "request deadline exceeded")),
          Math.max(0, deadlineAt - deps.now()),
        );
  const dispatchSignal = dispatchController.signal;
  // Set once a slot is claimed; see the acquire below for why the claim cannot
  // rely on a consumer to free it.
  let releaseOnAbort: (() => void) | null = null;
  const clearDeadline = () => {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    signal.removeEventListener("abort", abortFromClient);
    if (releaseOnAbort !== null) signal.removeEventListener("abort", releaseOnAbort);
  };
  const checkCancellation = () => {
    if (signal.aborted) throw signal.reason;
    if (deadlineAt !== null && (dispatchSignal.aborted || deps.now() >= deadlineAt))
      throw new GatewayError("TIMEOUT", "request deadline exceeded");
  };

  let model: VirtualModel;
  try {
    checkCancellation();
    const transformed = transformRequest(request, { enabled: snapshot.settings.rtkEnabled });
    dispatchRequest = transformed.request;
    log.rtkApplied = transformed.report.applied;
    log.rtkFilterHits = transformed.report.filterHits;
    log.rtkOriginalCodeUnits = transformed.report.originalCodeUnits;
    log.rtkCompressedCodeUnits = transformed.report.compressedCodeUnits;
    log.rtkEstimatedTokensSaved = transformed.report.estimatedTokensSaved;
    log.rtkFilters = transformed.report.filters;
    checkCancellation();
    model = resolveModel(dispatchRequest.model, snapshot);
  } catch (error) {
    const { code } = classify(error);
    clearDeadline();
    return fail(code, error instanceof Error ? error.message : "unresolvable model");
  }

  const { candidates, excluded } = rank({
    request: dispatchRequest,
    model,
    snapshot,
    now: startedAt,
    rand: deps.rand(),
    load: deps.loadRegistry.counts(),
  });

  logger.debug("routing candidates ranked", {
    requestId,
    requestedModel: request.model,
    model: candidates[0]?.target.model,
    credentialId: candidates[0]?.credential.id,
    count: candidates.length,
  });

  for (const e of excluded) {
    const capabilityOnly = e.reason === "capability:anthropicTools";
    log.degradations.push(
      capabilityOnly ? `excluded:${e.reason}` : `excluded:${e.credentialId}:${e.reason}`,
    );
    logger.debug("routing candidate excluded", {
      requestId,
      ...(capabilityOnly ? {} : { credentialId: e.credentialId }),
      reason: e.reason,
    });
  }

  if (candidates.length === 0) {
    clearDeadline();
    return fail("NO_CANDIDATES", `no eligible credential for model "${request.model}"`);
  }

  const maxAttempts = Math.min(snapshot.settings.maxAttempts, candidates.length);

  // Claimed here rather than at the first attempt, because `run()` is a
  // generator: its body does not start until the response is drained, several
  // turns later. A burst that arrives together would otherwise all rank before
  // any of them had claimed anything, read zero in flight, and pick the same
  // credential — the exact stacking this accounting exists to prevent.
  //
  // Ownership passes to the first attempt if it uses this candidate, and every
  // release is idempotent, so the attempt, the outer `finally` and the wrapper
  // below can all call it and the slot is still freed exactly once.
  const head = candidates[0] as Candidate;
  const eager = {
    credentialId: head.credential.id,
    model: head.target.model,
    release: deps.loadRegistry.acquire(head.credential.id, head.target.model),
  };
  let eagerHeld = true;

  // A claim taken before the generator starts has no owner until a consumer
  // touches it, and a consumer that wraps this generator in another one may
  // never touch it at all: closing an un-started wrapper skips its body, so the
  // `return` below is never reached. That is how the egress SSE wrapper behaves
  // when a client disconnects before the first pull. Client disconnect always
  // aborts this signal, so the abort is the one event that does not depend on
  // who is consuming.
  releaseOnAbort = () => eager.release();
  if (signal.aborted) eager.release();
  else signal.addEventListener("abort", releaseOnAbort, { once: true });

  const persistHealth = async (next: ReturnType<typeof recordSuccess>): Promise<void> => {
    await deps.store.credentials.saveHealth([next]);
  };

  const healthFor = (candidate: Candidate) =>
    snapshot.health.get(healthKey(candidate.credential.id, candidate.target.model)) ??
    blankHealth(candidate.credential.id, candidate.target.model);

  async function* run(): AsyncGenerator<StreamEvent, void, undefined> {
    try {
      let lastError: GatewayError | null = null;

      candidateLoop: for (let i = 0; i < maxAttempts; i++) {
        try {
          checkCancellation();
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          lastError =
            error instanceof GatewayError
              ? error
              : new GatewayError("TIMEOUT", "request deadline exceeded");
          break;
        }
        const candidate = candidates[i] as Candidate;

        // Claimed before the first await of the attempt. `onRoute` writes a row
        // in production, and claiming after it would leave the request counted
        // nowhere for the length of that write — visible to concurrent ranking
        // as a credential with less load than it really has.
        //
        // The first attempt normally adopts the slot claimed at rank time
        // rather than claiming a second one. Failover moves to a different
        // credential, so from the second attempt on this claims its own.
        const adoptable =
          eagerHeld &&
          eager.credentialId === candidate.credential.id &&
          eager.model === candidate.target.model;
        if (adoptable) eagerHeld = false;
        const releaseSlot = adoptable
          ? eager.release
          : deps.loadRegistry.acquire(candidate.credential.id, candidate.target.model);

        // Held for the whole attempt, including the stream drain, so ranking
        // sees this request as in flight until the last byte. Every way out of
        // the block below unwinds through the `finally` — return, break and
        // continue to the labelled loop, a throw from `onRoute` or a missing
        // adapter, and the generator being closed early mid-stream.
        try {
          log.attempts = i + 1;
          log.credentialId = candidate.credential.id;
          log.resolvedProvider = candidate.target.provider;
          log.resolvedModel = candidate.target.model;
          await deps.onRoute?.({
            provider: candidate.target.provider,
            model: candidate.target.model,
            credentialId: candidate.credential.id,
          });
          logger.debug("attempt started", {
            requestId,
            provider: candidate.target.provider,
            model: candidate.target.model,
            credentialId: candidate.credential.id,
            attempt: i + 1,
          });

          // Reset per-attempt: a failed attempt's partial usage must not leak into
          // the next one's log.
          log.inputTokens = 0;
          log.outputTokens = 0;
          log.cacheReadTokens = 0;
          log.cacheWriteTokens = 0;
          log.ttftMs = null;

          let committed = false;
          let authRefreshRetried = false;
          let retrySecrets: CredentialSecrets | undefined;
          const attemptNow = deps.now();
          const preemptiveRefreshRequired =
            candidate.credential.authType === "oauth" &&
            candidate.credential.expiresAt !== null &&
            candidate.credential.expiresAt - DISPATCH_REFRESH_LEAD_MS <= attemptNow;

          const adapter = deps.adapters[candidate.target.provider];
          if (adapter === undefined) {
            throw new GatewayError(
              "INTERNAL",
              `no adapter for provider ${candidate.target.provider}`,
            );
          }

          while (true) {
            try {
              const result = await waitForCancellation(
                attempt({
                  candidate,
                  request: dispatchRequest,
                  adapter,
                  http: deps.http,
                  now: attemptNow,
                  signal: dispatchSignal,
                  refresh: (credential) =>
                    waitForCancellation(deps.refresh(credential), dispatchSignal),
                  refreshLeadMs: DISPATCH_REFRESH_LEAD_MS,
                  ...(retrySecrets === undefined ? {} : { secrets: retrySecrets }),
                  logger,
                  requestId,
                }),
                dispatchSignal,
              );

              for (const d of result.degradations) log.degradations.push(d);

              let terminal = false;
              const pending: StreamEvent[] = [];
              for await (const event of result.events) {
                if (event.type === "blockDelta" && !committed) {
                  // Commit point: the client is about to see bytes, so from here on
                  // failover is impossible and errors must be forwarded in-stream.
                  committed = true;
                  log.ttftMs = deps.now() - startedAt;
                  logger.debug("stream committed", {
                    requestId,
                    provider: candidate.target.provider,
                    model: candidate.target.model,
                    credentialId: candidate.credential.id,
                    attempt: i + 1,
                    ttftMs: log.ttftMs,
                  });
                  for (const buffered of pending) yield buffered;
                  pending.length = 0;
                }

                if (event.type === "end") {
                  terminal = true;
                  log.inputTokens = event.usage.inputTokens;
                  log.outputTokens = event.usage.outputTokens;
                  log.cacheReadTokens = event.usage.cacheReadTokens;
                  log.cacheWriteTokens = event.usage.cacheWriteTokens;
                  log.costUsd = priceOf(
                    candidate.target.costPerMTok,
                    event.usage,
                    candidate.target.provider,
                  );
                }

                if (event.type === "error") {
                  terminal = true;
                  // An in-stream error before commit is retryable like a thrown one.
                  if (!committed && RETRYABLE[event.code]) {
                    throw new GatewayError(event.code, event.message);
                  }
                  // Not retried, so this attempt is terminal: yield the event, then
                  // record it as a failure and stop. Without this, an in-stream
                  // error that isn't thrown (this is how a decoder reports an
                  // error frame — see e.g. anthropic/decode.ts's "error" case)
                  // would fall through to the success path below once the
                  // generator ends, misreporting a failed request as a 200.
                  committed = true;
                  yield event;
                  await persistHealth(
                    recordFailure(healthFor(candidate), {
                      settings: snapshot.settings,
                      now: deps.now(),
                      code: event.code,
                      jitter: deps.rand(),
                    }),
                  );
                  log.status = HTTP_STATUS[event.code];
                  log.errorCode = event.code;
                  log.durationMs = deps.now() - startedAt;
                  return;
                }

                if (!committed && event.type !== "end") {
                  pending.push(event);
                } else {
                  if (!committed) {
                    for (const buffered of pending) yield buffered;
                    pending.length = 0;
                  }
                  yield event;
                }

                if (event.type === "end") break;
              }

              if (!terminal) {
                throw new GatewayError(
                  "UPSTREAM",
                  "upstream stream ended without a terminal event",
                );
              }

              await persistHealth(
                recordSuccess(healthFor(candidate), {
                  settings: snapshot.settings,
                  now: deps.now(),
                  ttftMs: log.ttftMs,
                }),
              );
              log.status = 200;
              log.errorCode = null;
              log.durationMs = deps.now() - startedAt;
              return;
            } catch (error) {
              if (signal.aborted) throw signal.reason;
              const classifiedError =
                deadlineAt !== null && dispatchSignal.aborted
                  ? { code: "TIMEOUT" as const }
                  : classify(error);
              const { code, retryAfterMs } = classifiedError;
              const message = error instanceof Error ? error.message : "attempt failed";
              lastError =
                retryAfterMs === undefined
                  ? new GatewayError(code, message)
                  : new GatewayError(code, message, { retryAfterMs });

              if (
                code === "AUTH" &&
                !committed &&
                !authRefreshRetried &&
                !preemptiveRefreshRequired &&
                candidate.credential.authType === "oauth" &&
                candidate.credential.hasRefreshToken
              ) {
                authRefreshRetried = true;
                logger.warn("attempt authentication failed; refreshing credential", {
                  requestId,
                  provider: candidate.target.provider,
                  model: candidate.target.model,
                  credentialId: candidate.credential.id,
                  attempt: i + 1,
                  code,
                });
                try {
                  retrySecrets = await waitForCancellation(
                    deps.refresh(candidate.credential),
                    dispatchSignal,
                  );
                  continue;
                } catch (refreshError) {
                  if (signal.aborted) throw signal.reason;
                  const classified =
                    deadlineAt !== null && dispatchSignal.aborted
                      ? { code: "TIMEOUT" as const }
                      : classify(refreshError);
                  const refreshMessage =
                    refreshError instanceof Error
                      ? refreshError.message
                      : "credential refresh failed";
                  lastError =
                    classified.retryAfterMs === undefined
                      ? new GatewayError(classified.code, refreshMessage)
                      : new GatewayError(classified.code, refreshMessage, {
                          retryAfterMs: classified.retryAfterMs,
                        });
                }
              }

              const failure = lastError as GatewayError;
              await persistHealth(
                recordFailure(healthFor(candidate), {
                  settings: snapshot.settings,
                  now: deps.now(),
                  code: failure.code,
                  ...(failure.retryAfterMs === undefined
                    ? {}
                    : { retryAfterMs: failure.retryAfterMs }),
                  jitter: deps.rand(),
                }),
              );

              if (!committed && RETRYABLE[failure.code] && i + 1 < maxAttempts) {
                logger.warn("attempt failed; retrying", {
                  requestId,
                  provider: candidate.target.provider,
                  model: candidate.target.model,
                  credentialId: candidate.credential.id,
                  attempt: i + 1,
                  code: failure.code,
                  retryable: true,
                  retryAfterMs: failure.retryAfterMs,
                });
              }

              if (committed) {
                // Bytes already went out; the client gets an in-band error and the
                // stream ends there.
                log.status = HTTP_STATUS[failure.code];
                log.errorCode = failure.code;
                log.durationMs = deps.now() - startedAt;
                yield {
                  type: "error",
                  code: failure.code,
                  message: failure.message,
                  retryable: false,
                };
                return;
              }

              if (!RETRYABLE[failure.code]) break candidateLoop;
              continue candidateLoop;
            }
          }
        } finally {
          releaseSlot();
        }
      }

      const code =
        lastError?.code === "TIMEOUT"
          ? "TIMEOUT"
          : lastError !== null && !RETRYABLE[lastError.code]
            ? lastError.code
            : "ALL_CANDIDATES_FAILED";
      log.status = HTTP_STATUS[code];
      log.errorCode = code;
      log.durationMs = deps.now() - startedAt;
      yield {
        type: "error",
        code,
        message: lastError?.message ?? "all candidates failed",
        retryable: false,
      };
    } finally {
      clearDeadline();
      // Covers the paths that never reach an attempt — cancellation at the top
      // of the loop breaks straight past the point where the slot is adopted.
      // Idempotent, so an adopted-and-already-released slot is untouched.
      eager.release();
      if (!dispatchController.signal.aborted) dispatchController.abort();
    }
  }

  const inner = run();

  // A slot is claimed before `run()`'s body can start, and closing a generator
  // that was never iterated skips its body entirely — so no `finally` inside
  // it can free that claim. `return`/`throw` are intercepted here instead,
  // which a consumer that walks away does call. Releases are idempotent, so
  // this and the attempt that adopted the slot still free it exactly once.
  // Each releases *after* the inner generator has unwound. Releasing first
  // would drop the count to zero while the attempt and its upstream connection
  // were still closing, and a request ranked in that window would read a live
  // request as absent. The `finally` still covers the un-started case, where
  // `inner.return` returns immediately without running anything.
  const events: AsyncGenerator<StreamEvent, void, undefined> = {
    next: (...args) => inner.next(...args),
    return: async (value) => {
      try {
        return await inner.return(value);
      } finally {
        eager.release();
      }
    },
    throw: async (error) => {
      try {
        return await inner.throw(error);
      } finally {
        eager.release();
      }
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    // `await using` disposes without going through `return`, so it needs the
    // same release.
    async [Symbol.asyncDispose]() {
      try {
        await inner[Symbol.asyncDispose]();
      } finally {
        eager.release();
      }
    },
  };

  return { events, log: () => log };
}

function waitForCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
