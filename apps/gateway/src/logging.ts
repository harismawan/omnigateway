import { type Logger, noopLogger, type ProviderId } from "@omni/ir";
import type { RequestLog, Store } from "@omni/store";

type CompletedOverrides = Pick<RequestLog, "status"> &
  Partial<Omit<RequestLog, "id" | "state" | "at" | "status">>;

type PendingRequestLogInput = Pick<
  RequestLog,
  "id" | "at" | "requestedModel" | "resolvedProvider" | "resolvedModel" | "credentialId"
>;

function requestLogDefaults(id: string, at: number): RequestLog {
  return {
    id,
    state: "done",
    at,
    apiKeyId: null,
    requestedModel: "",
    resolvedProvider: null,
    resolvedModel: null,
    credentialId: null,
    attempts: 0,
    status: 0,
    errorCode: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: null,
    durationMs: 0,
    costUsd: 0,
    degradations: [],
    rtkApplied: false,
    rtkFilterHits: 0,
    rtkOriginalCodeUnits: 0,
    rtkCompressedCodeUnits: 0,
    rtkEstimatedTokensSaved: 0,
    rtkFilters: [],
  };
}

export function newCompletedRequestLog(
  id: string,
  at: number,
  overrides: CompletedOverrides,
): RequestLog {
  return { ...requestLogDefaults(id, at), ...overrides, id, state: "done", at };
}

export function newPendingRequestLog(input: PendingRequestLogInput): RequestLog {
  const { id, at, requestedModel, resolvedProvider, resolvedModel, credentialId } = input;
  return {
    ...requestLogDefaults(id, at),
    requestedModel,
    resolvedProvider,
    resolvedModel,
    credentialId,
    state: "pending",
    status: 0,
  };
}

function report(logger: Logger, what: string, requestId: string, error: unknown): void {
  logger.warn(what, {
    requestId,
    // The message only; a store error must not drag a row's contents into stdout.
    reason: error instanceof Error ? error.message : "unknown",
  });
}

/**
 * Records a request that has started, so the console can show it running.
 *
 * The zeros this row carries are placeholders, not measurements — readers tell
 * the two apart by `state`. Never throws, for the same reason `finishLog` does
 * not: a log the operator watches must not be able to fail a request.
 */
export async function beginLog(
  store: Store,
  log: Omit<RequestLog, "state">,
  keyId: string | null,
  logger: Logger = noopLogger,
): Promise<void> {
  try {
    await store.usage.begin({ ...log, state: "pending", apiKeyId: keyId });
  } catch (error) {
    report(logger, "failed to record request start", log.id, error);
  }
}

/** Records the target once routing picks one, without completing the request. */
export async function routeLog(
  store: Store,
  requestId: string,
  target: { provider: ProviderId; model: string; credentialId: string },
  logger: Logger = noopLogger,
): Promise<void> {
  try {
    await store.usage.route(requestId, target);
  } catch (error) {
    report(logger, "failed to record request route", requestId, error);
  }
}

/**
 * Persists a finished request log, completing the pending row if one was
 * written.
 *
 * Never throws: a failure to write a log line must not turn a successful
 * proxied request into an error the client sees.
 */
export async function finishLog(
  store: Store,
  log: RequestLog,
  keyId: string | null,
  logger: Logger = noopLogger,
): Promise<void> {
  try {
    await store.usage.append({ ...log, apiKeyId: keyId });
  } catch (error) {
    report(logger, "failed to persist request log", log.id, error);
  }
}
