import type { GatewayError, LogFields } from "@omni/ir";
import { type Logger, noopLogger, type ProviderId } from "@omni/ir";
import type { RequestCompleted } from "@omni/plugins";
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
 * Writes one request's captured bodies, given the log that describes it.
 *
 * Takes the log rather than closing over one because the two sites that finish
 * a request finish different objects — dispatch's own live log on the success
 * path, a reconstructed one in the terminal catch — and the artifact records
 * whichever outcome was actually reached.
 */
export type BodyWriter = (log: RequestLog) => Promise<void>;

/**
 * Charges one finished request against whatever counts a key's usage.
 *
 * A callback rather than the limiter itself, so this module keeps knowing only
 * about a store and a logger, and so the site below can be read without going
 * and finding out what a rate limiter does.
 */
export type UsageDebit = (keyId: string, usage: { tokens: number; costUsd: number }) => void;

/**
 * Persists a finished request log, completing the pending row if one was
 * written, and with it whatever bodies were captured for the request.
 *
 * Never throws: a failure to write a log line must not turn a successful
 * proxied request into an error the client sees.
 *
 * `bodies` runs here rather than at its own call site because this function is
 * already the one place that runs exactly once per request id, on both the
 * success and the error path — `usage.append` double-counts `usage_daily` if it
 * runs twice, and an artifact write has the same shape of problem. It runs
 * second and in a `try` of its own: the row is the record every operator relies
 * on, and an opt-in body corpus must not be able to cost them one.
 *
 * `debit` runs here for the same reason, and beside the append rather than
 * inside it: `@omni/store` keeps rows behind itself and has no business knowing
 * a gateway limiter exists, while this function is already the one site that
 * runs at most once per request id. A second lifecycle hook next to it would
 * have to re-establish that guarantee; a debit here inherits it.
 */
/**
 * Announces a finished request to plugin handlers.
 *
 * Takes the built payload rather than the log row: the translation from
 * `RequestLog` to the narrower shape plugins see happens once, here, beside the
 * guarantee that makes it correct. A caller that built its own would be a second
 * site to keep in step with what plugins are allowed to know.
 */
export type PluginEmit = (event: RequestCompleted) => void;

export async function finishLog(
  store: Store,
  log: RequestLog,
  keyId: string | null,
  logger: Logger = noopLogger,
  bodies?: BodyWriter,
  debit?: UsageDebit,
  emit?: PluginEmit,
): Promise<void> {
  try {
    await store.usage.append({ ...log, apiKeyId: keyId });
  } catch (error) {
    report(logger, "failed to persist request log", log.id, error);
  }
  // Whether or not the row landed: a key that spent the tokens spent them, and
  // the limiter should not forget them because a write failed under load.
  //
  // The reach of that is one cache TTL, not forever, and the limit of it is
  // worth stating rather than discovering. A debit lives in the in-memory delta
  // until the next store read-through, which trims anything older than the
  // instant it read — and the row this debit stood in for is not in that read,
  // because it was never written. So a failed write is covered for as long as
  // the delta holds it and not beyond. Retaining such debits across the trim
  // would fix that and would double-count every debit whose row did land, which
  // is the worse of the two errors and the one this design refuses.
  //
  // All four token classes are disjoint — `Usage.inputTokens` is uncached
  // input — so summing them double-counts none.
  if (keyId !== null && debit !== undefined) {
    debit(keyId, {
      tokens: log.inputTokens + log.outputTokens + log.cacheReadTokens + log.cacheWriteTokens,
      costUsd: log.costUsd,
    });
  }
  /**
   * Emitted here for the reason the debit is: this function is already the one
   * site that runs at most once per request id, and a plugin accumulating
   * per-request quantities needs exactly that guarantee. A second lifecycle hook
   * elsewhere would have to re-establish it.
   *
   * The payload is narrower than the row on purpose — no credential id, no
   * bodies, no headers. Widening it is a security change, because it crosses
   * into code authored outside this repository.
   *
   * A key is required: every consumer of this event attributes to one, and a
   * request that never authenticated has nothing to attribute to. `emit` itself
   * only enqueues, so nothing here runs a plugin's code on the request path.
   */
  if (keyId !== null && emit !== undefined) {
    try {
      emit({
        requestId: log.id,
        apiKeyId: keyId,
        provider: log.resolvedProvider,
        model: log.resolvedModel ?? log.requestedModel,
        tokens: {
          input: log.inputTokens,
          output: log.outputTokens,
          cacheRead: log.cacheReadTokens,
          cacheWrite: log.cacheWriteTokens,
        },
        costUsd: log.costUsd,
        durationMs: log.durationMs,
        ok: log.errorCode === null && log.status < 400,
        at: log.at,
      });
    } catch (error) {
      // The bus only enqueues, so reaching here means the bus itself broke
      // rather than a plugin. Either way this function's contract is that it
      // never throws: a logging failure must not turn a proxied request the
      // client already received into an error.
      report(logger, "failed to emit plugin event", log.id, error);
    }
  }
  if (bodies === undefined) return;
  try {
    await bodies(log);
  } catch (error) {
    report(logger, "failed to persist request bodies", log.id, error);
  }
}
