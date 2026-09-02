import { DISPATCH_REFRESH_LEAD_MS } from "@omni/control";
import {
  type ChatRequest,
  describeError,
  GatewayError,
  HTTP_STATUS,
  type Logger,
  noopLogger,
  type ProviderId,
  RETRYABLE,
  type StreamEvent,
  safeToken,
} from "@omni/ir";
import { injectPonytail, ponytailNotes } from "@omni/ponytail";
import type { HttpClient, ProviderAdapter } from "@omni/providers";
import type { ProviderDescriptors } from "@omni/providers/descriptors";
import {
  blankHealth,
  type Candidate,
  rank,
  recordFailure,
  recordSuccess,
  resolveModel,
} from "@omni/router";
import { transformRequest } from "@omni/rtk";
import type {
  CredentialHealth,
  CredentialSecrets,
  CredentialView,
  RequestLog,
  Store,
  VirtualModel,
} from "@omni/store";
import { newCompletedRequestLog, reasonField, reportRejection } from "../logging.ts";
import { attempt } from "./attempt.ts";
import { classify } from "./classify.ts";
import type { LoadRegistry } from "./loadRegistry.ts";
import { priceOf } from "./price.ts";
import type { RoutingSnapshotSource } from "./snapshotCache.ts";

export type DispatchDeps = {
  store: Store;
  snapshots: RoutingSnapshotSource;
  adapters: Readonly<Partial<Record<ProviderId, ProviderAdapter>>>;
  /**
   * Which providers this installation has. Defaults to the real registry.
   *
   * A separate injection point from `adapters`, and the two can disagree —
   * that disagreement is exactly what the `INTERNAL "no adapter for provider"`
   * throw below reports. Threaded into `resolveModel` and `rank` so routing
   * judges the same installation this lookup does.
   */
  providers?: ProviderDescriptors;
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

  /**
   * Reports a terminal failure.
   *
   * Nearly every way dispatch fails ends in a yielded error event rather than a
   * throw — `fail`, a decoder's own terminal event, a throw after the commit
   * point, and the exhausted candidate loop. The route reads that event and
   * renders an error response, so its own `catch` never runs and nothing about
   * the failure reaches stdout. `request_logs` holds a status and a code and no
   * message, so without this line the reason a request failed is recoverable
   * from nowhere. The exceptions still throw past here — a missing adapter, a
   * `persistHealth` store error, an abort — and the route logs those itself.
   *
   * Every caller is a site that decided an outcome, and passes the error that
   * decided it. Wrapping the returned generator and reporting whatever error
   * event went past would be tidier, but an event carries no record of who
   * wrote its message, so that version had to guess — and withheld the
   * gateway's own `"request deadline exceeded"` as though it were an upstream
   * body, hiding the single fact this line exists to carry.
   *
   * Called once the log carries the failure, so the fields it reads are the
   * ones the row will hold.
   *
   * One line per request is a property of the call sites, not of a guard here:
   * every one of them returns immediately after reporting, and `fail` hands
   * back its own generator without `run()` ever starting. A latch used to sit
   * in this function, but nothing reachable could trip it — it only had an
   * effect if a consumer called `throw()` into the stream, which no caller
   * does. **A new terminal site must return once it has reported**, or it will
   * report again on the way out and there is no longer anything to stop it.
   */
  const reject = (error: GatewayError): void => {
    reportRejection(logger, requestId, log, error);
  };

  /**
   * Records what a request lost, once per distinct entry.
   *
   * Both sites that collect degradations go through here — the successful
   * attempt's `AdapterResult` and the failed attempt's `GatewayError` — because
   * a request can reach both across a failover, and `request_logs.degradations`
   * means a set: "images were dropped" is one fact however many attempts
   * dropped them. `note()` in an adapter's `toWire` dedupes within a single
   * attempt; only this dedupes across them.
   *
   * Two attempts against the same provider already produced duplicate entries
   * before this existed — a pre-commit stream error failing over to a second
   * Anthropic credential doubled `anthropic:oauth-system-prefix`.
   */
  const noteDegradations = (entries: readonly string[]): void => {
    for (const d of entries) {
      if (!log.degradations.includes(d)) log.degradations.push(d);
    }
  };

  /**
   * Whether this error *is* the client hanging up, rather than merely having
   * happened while one was in progress.
   *
   * `checkCancellation` and the attempt catch both rethrow `signal.reason`
   * verbatim, and a fetch aborted by the client rejects with that same reason
   * because `abortFromClient` passes it on — so identity answers this exactly.
   * Asking `signal.aborted` instead files a genuine failure that merely
   * coincided with a disconnect as a clean 499 and prints nothing, which is how
   * a store outage comes to read as "our clients are all disconnecting". The
   * deadline aborts with a `GatewayError` of its own, so it never matches here.
   */
  const isClientAbort = (error: unknown): boolean => signal.aborted && error === signal.reason;

  /**
   * Re-wraps a classified error, keeping who wrote the message.
   *
   * `provider` and `gatewayAuthored` are the redaction gate's two inputs, and
   * dropping either here reverses the answer in its own direction: without the
   * first every re-wrapped upstream error read as gateway-authored, and without
   * the second a codec's own failure — the case the flag exists for — arrived
   * with its reason withheld anyway. The second was live for exactly as long as
   * it took a test to ask.
   */
  const rewrap = (classified: ReturnType<typeof classify>, message: string): GatewayError =>
    new GatewayError(classified.code, message, {
      ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }),
      ...(classified.provider === undefined ? {} : { provider: classified.provider }),
      ...(classified.gatewayAuthored ? { gatewayAuthored: true } : {}),
    });

  /**
   * A failure decided before any attempt ran.
   *
   * `cancelled` marks the client having hung up rather than anything having
   * gone wrong: the row records 499 like every other disconnect and nothing is
   * printed. A hang-up during model resolution otherwise classifies as
   * `TIMEOUT` and prints a 504 rejection — the very line the route suppresses
   * on every other disconnect path, at whatever rate the client retried.
   */
  const fail = (
    code: GatewayError["code"],
    message: string,
    cancelled = false,
  ): DispatchOutcome => {
    log.errorCode = cancelled ? "interrupted" : code;
    log.status = cancelled ? 499 : HTTP_STATUS[code];
    log.durationMs = deps.now() - startedAt;
    // Everything `fail` reports happens before an attempt runs, so the message
    // is always this gateway's own and prints without waiting for debug.
    if (!cancelled) reject(new GatewayError(code, message));
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
    // Both transforms run once here, ahead of routing, so every attempt of a
    // failover sends the same bytes. Their order is not load-bearing — RTK
    // rewrites tool results and ponytail appends to the system prompt — and is
    // fixed only so the recorded degradations read the same way every time.
    const lazy = injectPonytail(transformed.request, {
      mode: snapshot.settings.ponytailMode,
    });
    dispatchRequest = lazy.request;
    noteDegradations(ponytailNotes(lazy.report));
    log.rtkApplied = transformed.report.applied;
    log.rtkFilterHits = transformed.report.filterHits;
    log.rtkOriginalCodeUnits = transformed.report.originalCodeUnits;
    log.rtkCompressedCodeUnits = transformed.report.compressedCodeUnits;
    log.rtkEstimatedTokensSaved = transformed.report.estimatedTokensSaved;
    log.rtkFilters = transformed.report.filters;
    checkCancellation();
    model = resolveModel(dispatchRequest.model, snapshot, deps.providers);
  } catch (error) {
    clearDeadline();
    if (isClientAbort(error)) return fail("TIMEOUT", "client disconnected", true);
    const { code } = classify(error);
    return fail(code, describeError(error, "unresolvable model"));
  }

  // The one yield between here and the eager claim below. `counts` and
  // `acquire` are synchronous, so a burst on this process ranks and claims
  // without another request slipping in between the two.
  await deps.loadRegistry.refresh();
  const { candidates, excluded } = rank({
    request: dispatchRequest,
    model,
    snapshot,
    now: startedAt,
    rand: deps.rand(),
    load: deps.loadRegistry.counts(),
    // Threaded rather than left to the router's default, so routing, the
    // adapter lookup and pricing all judge the same installation. Every site in
    // this function passes `deps.providers` the same way and `undefined`
    // everywhere selects the same real registry — one spelling, because the
    // round that added two threadings and forgot the third is what more than
    // one costs.
    providers: deps.providers,
  });

  logger.debug("routing candidates ranked", {
    requestId,
    requestedModel: request.model,
    model: candidates[0]?.target.model,
    credentialId: candidates[0]?.credential.id,
    count: candidates.length,
  });

  for (const e of excluded) {
    // A capability exclusion is a fact about the target's provider, not about
    // the account, so naming an account there would blame one that is fine.
    // Read off the router's own discriminator rather than off the reason
    // string: that string is persisted, and matching it made renaming the
    // concept a silent change to what gets redacted.
    const aboutTheTarget = e.kind === "target";
    // Through `noteDegradations`, not a bare push. This was the one writer in
    // the file that bypassed it, and it is the one that can repeat: `eligible`
    // emits `capability:providerNative` from inside its credential loop, so a
    // pool of 5 targets across 6 accounts produced 24 identical rows — on an
    // ordinary web-search request that *succeeded*. `request_logs.degradations`
    // is unbounded text, and the console renders one chip per entry keyed on the
    // string, so the logs panel showed 24 duplicates and a React duplicate-key
    // warning on the happy path.
    //
    // Deduping here rather than moving `drop()` out of that loop, because the
    // per-credential emission is what makes the *other* reasons name the account
    // they are about. The set semantics `noteDegradations` documents twenty
    // lines above is the invariant; this was the site that did not hold it.
    noteDegradations([
      aboutTheTarget ? `excluded:${e.reason}` : `excluded:${e.credentialId}:${e.reason}`,
    ]);
    logger.debug("routing candidate excluded", {
      requestId,
      ...(aboutTheTarget ? {} : { credentialId: e.credentialId }),
      reason: e.reason,
    });
  }

  if (candidates.length === 0) {
    clearDeadline();
    return fail("NO_CANDIDATES", `no eligible credential for model "${safeToken(request.model)}"`);
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

  /**
   * Records a health transition for one candidate.
   *
   * `transition` is applied to the row on disk, inside the store's write
   * transaction — not to `snapshot.health`, which was read before the upstream
   * call and is stale by the time any of this runs. Two requests failing the
   * same credential at once each count, and a rate limit landing after a hard
   * failure no longer carries that failure's count back to what it was.
   */
  const persistHealth = async (
    candidate: Candidate,
    transition: (current: CredentialHealth) => CredentialHealth,
  ): Promise<void> => {
    const credentialId = candidate.credential.id;
    const { model } = candidate.target;
    await deps.store.credentials.updateHealth(credentialId, model, (current) =>
      transition(current ?? blankHealth(credentialId, model)),
    );
  };

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

          // `Object.hasOwn`, and here rather than at whoever built the map.
          //
          // `candidate.target.provider` is a stored string, and `deps.adapters`
          // is a public injection point constructed directly by callers and by
          // tests — an ordinary object literal, which answers the `Object`
          // constructor for `constructor`. The lookup would then succeed and
          // `adapter.send` would be called on a function that has no `send`.
          //
          // Nothing normalises the map upstream. An earlier version did so in
          // `createApp`, which covered exactly one of the ways this object is
          // built; that was deleted rather than kept, because a guard covering
          // one construction path reads as if it covers all of them.
          //
          // Guarding at the read site rather than at construction is the whole
          // point: this is the one place always on the path, and it cannot be
          // bypassed by a caller who builds the map some other way. The
          // `@omni/providers` tables drop their prototypes for the same reason
          // — one invariant where the value is read, not a rule every producer
          // has to remember.
          const adapter = Object.hasOwn(deps.adapters, candidate.target.provider)
            ? deps.adapters[candidate.target.provider]
            : undefined;
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
                  autoCache: snapshot.settings.autoCacheEnabled,
                }),
                dispatchSignal,
              );

              noteDegradations(result.degradations);

              // Beside the degradation the adapter already recorded, and for the
              // same reason: a cloak that silently misbehaves has no other signal.
              // The count only — the names it renamed are client free text and
              // `LogFields` is where that line is drawn.
              if (result.cloakedTools !== undefined) {
                logger.debug("tool names cloaked", {
                  requestId,
                  provider: candidate.target.provider,
                  credentialId: candidate.credential.id,
                  attempt: i + 1,
                  cloakedTools: result.cloakedTools,
                });
              }

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
                  // `deps.providers`, the same registry routing judged this
                  // candidate against. Reading the module-global here instead
                  // let the two disagree: a provider that the injected registry
                  // held and the global one did not would route, dispatch, and
                  // then have its cache writes priced at zero.
                  //
                  // Passing `undefined` is meaningful, not a gap — it selects
                  // `priceOf`'s own default, which is that same module-global.
                  // That is the production path, since `createApp` sets no
                  // `providers`, and it has its own end-to-end test.
                  log.costUsd = priceOf(
                    candidate.target.costPerMTok,
                    event.usage,
                    candidate.target.provider,
                    deps.providers,
                  );
                }

                if (event.type === "error") {
                  terminal = true;
                  // An in-stream error before commit is retryable like a thrown one.
                  if (!committed && RETRYABLE[event.code]) {
                    // Named, because the message is the upstream's own words and
                    // `reasonField` withholds a message whose error names a
                    // provider. Unnamed, this printed the upstream body at
                    // default level — the exact disclosure `httpError` avoids by
                    // stamping the provider on the non-streaming path, on a path
                    // that is the streaming default for the busiest client here.
                    // A context-length refusal quotes prompt text back.
                    throw new GatewayError(event.code, event.message, {
                      provider: candidate.target.provider,
                    });
                  }
                  // Not retried, so this attempt is terminal: yield the event, then
                  // record it as a failure and stop. Without this, an in-stream
                  // error that isn't thrown (this is how a decoder reports an
                  // error frame — see e.g. anthropic/decode.ts's "error" case)
                  // would fall through to the success path below once the
                  // generator ends, misreporting a failed request as a 200.
                  committed = true;
                  // Recorded before the yield, not after. The consumer reads the
                  // event during that yield — the rejection line prints there,
                  // and the route completes the row from it — so a log still
                  // carrying `status: 0` would report this failure as neither a
                  // success nor a failure. A consumer that abandons the stream
                  // here never resumes the body at all, and would leave it that
                  // way permanently.
                  log.status = HTTP_STATUS[event.code];
                  log.errorCode = event.code;
                  log.durationMs = deps.now() - startedAt;
                  // A decoder raises this from an error frame the upstream
                  // sent, so the message is the upstream's own words.
                  reject(
                    new GatewayError(event.code, event.message, {
                      provider: candidate.target.provider,
                    }),
                  );
                  yield event;
                  try {
                    await persistHealth(candidate, (current) =>
                      recordFailure(current, {
                        settings: snapshot.settings,
                        now: deps.now(),
                        code: event.code,
                        jitter: deps.rand(),
                      }),
                    );
                  } catch (healthError) {
                    // Bookkeeping, and this request's outcome was decided and
                    // reported before the yield above. Letting the write reach
                    // the catch below would reassign the status the row keeps
                    // and yield a SECOND error event: the client receiving two
                    // terminal frames, and stdout disagreeing with its own row
                    // about the same requestId.
                    logger.error("failed to persist credential health", {
                      requestId,
                      provider: candidate.target.provider,
                      credentialId: candidate.credential.id,
                      reason: describeError(healthError, "unknown"),
                    });
                  }
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

              await persistHealth(candidate, (current) =>
                recordSuccess(current, {
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
              const { code } = classifiedError;
              const message = describeError(error, "attempt failed");
              lastError = rewrap(classifiedError, message);

              // A failed attempt still built a wire body, and what the request
              // lost building it is recorded on the error because there is no
              // result to carry it.
              if (error instanceof GatewayError) noteDegradations(error.degradations);

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
                  const refreshMessage = describeError(refreshError, "credential refresh failed");
                  lastError = rewrap(classified, refreshMessage);
                  // The refresh *attempt* is logged above. Without this the
                  // failure is not, so a dead refresh token reads as a refresh
                  // that worked followed by an unexplained 503.
                  logger.warn("credential refresh failed", {
                    requestId,
                    provider: candidate.target.provider,
                    model: candidate.target.model,
                    credentialId: candidate.credential.id,
                    attempt: i + 1,
                    code: classified.code,
                    // Same predicate as every other rejection line. Most of what
                    // reaches here this gateway wrote — a discovery document
                    // that failed its HTTPS check, a provider with no refresh
                    // grant, a token response with no `access_token` — and
                    // withholding those left the operator with a bare
                    // `code=UPSTREAM` for the fault the line exists to explain.
                    ...reasonField(lastError, logger),
                  });
                }
              }

              const failure = lastError as GatewayError;
              await persistHealth(candidate, (current) =>
                recordFailure(current, {
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
                reject(failure);
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
      const message = lastError?.message ?? "all candidates failed";
      // Whoever wrote the last candidate's message wrote this one. Where no
      // candidate ever ran there is no `lastError`, and the text below is this
      // gateway's own — which is exactly the case a blanket "assume upstream"
      // used to withhold.
      reject(
        lastError?.provider === undefined
          ? new GatewayError(code, message)
          : new GatewayError(code, message, {
              provider: lastError.provider,
              // The message is `lastError`'s verbatim, so its provenance is too.
              ...(lastError.gatewayAuthored ? { gatewayAuthored: true } : {}),
            }),
      );
      yield {
        type: "error",
        code,
        message,
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
