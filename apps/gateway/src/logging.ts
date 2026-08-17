import type { GatewayError, LogFields } from "@omni/ir";
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

/**
 * Whether a failure's message can quote the request back at stdout.
 *
 * `GatewayError.provider` is set by `httpError` and nowhere else, and that is
 * the one constructor that fills a message from an upstream response body — up
 * to 500 characters of it, which a context-length or validation error echoes
 * prompt text into. So an upstream's words wait for debug. A message this
 * gateway wrote cannot leak a prompt and is the whole reason an operator reads
 * the line, so it prints at the default level.
 *
 * This is the only predicate behind `reason` on a rejection line, and it asks
 * the error rather than the call site on purpose. Three call-site guesses —
 * a `fromUpstream` boolean passed by hand, a bare `enabled("debug")`, and a
 * `provider` re-derived after dispatch had already dropped it — disagreed with
 * each other about the same error. Preserving `provider` across re-wraps (see
 * `classify`) is what makes the question answerable at all.
 */
export function reasonField(error: GatewayError, logger: Logger): { reason?: string } {
  return error.provider === undefined || logger.enabled("debug") ? { reason: error.message } : {};
}

/**
 * Prints why a request failed, once, from whichever site decided it.
 *
 * `request_logs` holds a status and an error code and no message, so without
 * this line the reason a request failed is recoverable from nowhere. The row
 * still carries everything else; this is the part that cannot be a column.
 *
 * The caller assigns the log's terminal status first, so the fields below are
 * the ones the row will hold and stdout cannot disagree with the console.
 *
 * `INTERNAL` is the gateway's own defect rather than a request being refused,
 * and it reads at `error` wherever it happens. The level is decided here rather
 * than per call site because the same escaped store write used to print at
 * `error` on the streaming path and `warn` on the non-streaming one, so an
 * operator paging on `level=error` was never woken for half of an outage.
 */
export function reportRejection(
  logger: Logger,
  requestId: string,
  log: RequestLog,
  error: GatewayError,
  surface?: "anthropic" | "openai",
): void {
  const fields: LogFields = {
    requestId,
    ...(surface === undefined ? {} : { surface }),
    status: log.status,
    provider: log.resolvedProvider ?? undefined,
    model: log.resolvedModel ?? undefined,
    credentialId: log.credentialId ?? undefined,
    code: error.code,
    attempts: log.attempts,
    ...reasonField(error, logger),
  };
  if (error.code === "INTERNAL") logger.error("request rejected", fields);
  else logger.warn("request rejected", fields);
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
