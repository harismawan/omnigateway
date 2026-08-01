import {
  type ChatRequest,
  GatewayError,
  HTTP_STATUS,
  type ProviderId,
  RETRYABLE,
  type StreamEvent,
} from "@omni/ir";
import type { HttpClient, ProviderAdapter } from "@omni/providers";
import type {
  CredentialSecrets,
  CredentialView,
  RequestLog,
  Store,
  VirtualModel,
} from "@omni/store";
import { blankHealth, recordFailure, recordSuccess } from "../router/breaker.ts";
import { buildSnapshot, type Candidate, healthKey, rank, resolveModel } from "../router/index.ts";
import { attempt } from "./attempt.ts";
import { classify } from "./classify.ts";

/** Refresh this far ahead of expiry so a long stream cannot outlive its token. */
const REFRESH_LEAD_MS = 120_000;

export type DispatchDeps = {
  store: Store;
  adapters: Readonly<Record<ProviderId, ProviderAdapter>>;
  /** Order-preserving transport. Never globalThis.fetch — see Global Constraints. */
  http: HttpClient;
  now: () => number;
  rand: () => number;
  refresh: (credential: CredentialView) => Promise<CredentialSecrets>;
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
): Promise<DispatchOutcome> {
  const startedAt = deps.now();
  const snapshot = await buildSnapshot(deps.store, startedAt);

  const log: RequestLog = {
    id: crypto.randomUUID(),
    at: startedAt,
    apiKeyId: null,
    requestedModel: request.model,
    resolvedProvider: null,
    resolvedModel: null,
    credentialId: null,
    attempts: 0,
    status: 200,
    errorCode: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: null,
    durationMs: 0,
    costUsd: 0,
    degradations: [],
  };

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

  let model: VirtualModel;
  try {
    model = resolveModel(request.model, snapshot);
  } catch (error) {
    const { code } = classify(error);
    return fail(code, error instanceof Error ? error.message : "unresolvable model");
  }

  const { candidates, excluded } = rank({
    request,
    model,
    snapshot,
    now: startedAt,
    rand: deps.rand(),
  });

  for (const e of excluded) {
    log.degradations.push(`excluded:${e.credentialId}:${e.reason}`);
  }

  if (candidates.length === 0) {
    return fail("NO_CANDIDATES", `no eligible credential for model "${request.model}"`);
  }

  const maxAttempts = Math.min(snapshot.settings.maxAttempts, candidates.length);

  const persistHealth = async (next: ReturnType<typeof recordSuccess>): Promise<void> => {
    await deps.store.credentials.saveHealth([next]);
  };

  const healthFor = (candidate: Candidate) =>
    snapshot.health.get(healthKey(candidate.credential.id, candidate.target.model)) ??
    blankHealth(candidate.credential.id, candidate.target.model);

  async function* run(): AsyncGenerator<StreamEvent, void, undefined> {
    let lastError: GatewayError | null = null;

    for (let i = 0; i < maxAttempts; i++) {
      const candidate = candidates[i] as Candidate;
      log.attempts = i + 1;
      log.credentialId = candidate.credential.id;
      log.resolvedProvider = candidate.target.provider;
      log.resolvedModel = candidate.target.model;

      // Reset per-attempt: a failed attempt's partial usage must not leak into
      // the next one's log.
      log.inputTokens = 0;
      log.outputTokens = 0;
      log.cacheReadTokens = 0;
      log.cacheWriteTokens = 0;
      log.ttftMs = null;

      let committed = false;

      try {
        const result = await attempt({
          candidate,
          request,
          adapter: deps.adapters[candidate.target.provider],
          http: deps.http,
          now: deps.now(),
          signal,
          refresh: deps.refresh,
          refreshLeadMs: REFRESH_LEAD_MS,
        });

        for (const d of result.degradations) log.degradations.push(d);

        for await (const event of result.events) {
          if (event.type === "blockDelta" && !committed) {
            // Commit point: the client is about to see bytes, so from here on
            // failover is impossible and errors must be forwarded in-stream.
            committed = true;
            log.ttftMs = deps.now() - startedAt;
          }

          if (event.type === "end") {
            log.inputTokens = event.usage.inputTokens;
            log.outputTokens = event.usage.outputTokens;
            log.cacheReadTokens = event.usage.cacheReadTokens;
            log.cacheWriteTokens = event.usage.cacheWriteTokens;
            log.costUsd = priceOf(candidate, event.usage);
          }

          if (event.type === "error") {
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

          yield event;
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
        const { code, retryAfterMs } = classify(error);
        const message = error instanceof Error ? error.message : "attempt failed";
        lastError =
          retryAfterMs === undefined
            ? new GatewayError(code, message)
            : new GatewayError(code, message, { retryAfterMs });

        await persistHealth(
          recordFailure(healthFor(candidate), {
            settings: snapshot.settings,
            now: deps.now(),
            code,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            jitter: deps.rand(),
          }),
        );

        if (committed) {
          // Bytes already went out; the client gets an in-band error and the
          // stream ends there.
          log.status = HTTP_STATUS[code];
          log.errorCode = code;
          log.durationMs = deps.now() - startedAt;
          yield { type: "error", code, message, retryable: false };
          return;
        }

        if (!RETRYABLE[code]) break;
      }
    }

    const code =
      lastError !== null && !RETRYABLE[lastError.code] ? lastError.code : "ALL_CANDIDATES_FAILED";
    log.status = HTTP_STATUS[code];
    log.errorCode = code;
    log.durationMs = deps.now() - startedAt;
    yield {
      type: "error",
      code,
      message: lastError?.message ?? "all candidates failed",
      retryable: false,
    };
  }

  return { events: run(), log: () => log };
}

function priceOf(
  candidate: Candidate,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
): number {
  const p = candidate.target.costPerMTok;
  const cacheRate = p.cacheRead ?? p.input * 0.1;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * cacheRate) /
    1_000_000
  );
}
