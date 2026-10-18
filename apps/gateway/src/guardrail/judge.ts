import {
  type ChatRequest,
  collect,
  type ErrorCode,
  GatewayError,
  HTTP_STATUS,
  type LogFields,
  type Logger,
  RETRYABLE,
  type StreamEvent,
} from "@omni/ir";
import type { RequestLog } from "@omni/store";
import { type DispatchDeps, type DispatchOutcome, dispatch } from "../dispatch/index.ts";
import {
  beginLog,
  finishLog,
  newCompletedRequestLog,
  newPendingRequestLog,
  type PluginEmit,
  reasonField,
  reportRejection,
  routeLog,
  type UsageDebit,
} from "../logging.ts";
import type { Invalidator } from "../stream/broadcaster.ts";
import type { Telemetry } from "../telemetry/index.ts";
import { type VerdictCache, verdictKey } from "./cache.ts";
import { classifierRequest, parseVerdict, type Verdict } from "./classifier.ts";
import { judgedText } from "./extract.ts";

/** The classifier said no. `CONTENT_FILTER`, 400. */
export const REFUSED_MESSAGE = "request refused by this API key's usage policy";
/** The classifier timed out, failed, or answered something unreadable. `UPSTREAM`, 502. */
export const UNAVAILABLE_MESSAGE = "usage policy check unavailable";
/** The key carries a policy and no classifier model is configured. `INTERNAL`, 500. */
export const UNCONFIGURED_MESSAGE = "usage policy check is not configured";

/** On the classifier call's own row, the link between it and the request it judged. */
export const CLASSIFIER_NOTE = "guardrail:classifier";

/**
 * What the request path needs beyond dispatch's own wiring. The classifier
 * writes its own row, so it needs everything `finishLog` is handed.
 */
export type GuardrailDeps = DispatchDeps & {
  requestId: () => string;
  logger: Logger;
  cache: VerdictCache;
  emit?: PluginEmit | undefined;
  broadcaster?: Invalidator | undefined;
  telemetry?: Telemetry | undefined;
};

/**
 * How judging ended, and the degradations the parent row records for it.
 *
 * `cancelled` is the client hanging up while the check ran. It is not a failed
 * check: the request is over, and it is recorded as the disconnect it is.
 */
export type GuardrailOutcome =
  | { kind: "allowed"; notes: readonly string[] }
  | { kind: "refused"; error: GatewayError; notes: readonly string[] }
  | { kind: "cancelled" };

/**
 * Fixed and gateway-authored, every one. The classifier's own words never reach
 * the client — they are model-written free text and may restate the policy —
 * and `gatewayAuthored` lets the rejection line print the reason without debug.
 */
const refusal = (code: ErrorCode, message: string): GatewayError =>
  new GatewayError(code, message, { gatewayAuthored: true });

type ClassifierResult =
  | { kind: "verdict"; verdict: Verdict }
  | { kind: "failed"; reason: string; code?: ErrorCode }
  | { kind: "cancelled" };

/**
 * One classifier call through `dispatch`, under its own request id, with its own
 * `request_logs` row charged to the key whose request it judged.
 *
 * - **No request transforms**: the request is the gateway's own; a ponytail
 *   ruleset in its instruction would change the verdict and bill the key for it.
 * - **No body capture**: `deps.http` is the bare transport, never the parent's
 *   capturing decorator, whatever the body-logging settings say.
 * - **No admission**: it rides the parent's. The row it writes is still seen by
 *   the long windows and debited for tokens and spend through `finishLog`,
 *   against the classifier model's override where the key has one.
 *
 * The timeout and the client's own signal are composed into one, so a client
 * that hangs up stops the classifier too; the two are told apart afterwards by
 * asking which of them fired.
 */
async function callClassifier(
  deps: GuardrailDeps,
  input: {
    apiKeyId: string;
    request: ChatRequest;
    signal: AbortSignal;
    timeoutMs: number;
    debit: UsageDebit;
  },
): Promise<ClassifierResult> {
  const id = deps.requestId();
  const at = deps.now();
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(refusal("TIMEOUT", "usage policy check timed out")),
    input.timeoutMs,
  );
  const signal = AbortSignal.any([input.signal, timeout.signal]);

  let outcome: DispatchOutcome | null = null;
  const events: StreamEvent[] = [];
  let thrown: { error: unknown } | null = null;
  let began = false;
  try {
    outcome = await dispatch(
      input.request,
      {
        ...deps,
        trace: null,
        async onRoute(target) {
          if (began) {
            await routeLog(deps.store, id, target, deps.logger, deps.broadcaster);
            return;
          }
          began = true;
          await beginLog(
            deps.store,
            newPendingRequestLog({
              id,
              at,
              requestedModel: input.request.model,
              resolvedProvider: target.provider,
              resolvedModel: target.model,
              credentialId: target.credentialId,
            }),
            input.apiKeyId,
            deps.logger,
            deps.broadcaster,
          );
        },
      },
      signal,
      id,
      { requestTransforms: false },
    );
    for await (const event of outcome.events) events.push(event);
  } catch (error) {
    thrown = { error };
  } finally {
    clearTimeout(timer);
  }

  const cancelled = input.signal.aborted;
  const timedOut = !cancelled && timeout.signal.aborted;
  const failure = events.find(
    (e): e is Extract<StreamEvent, { type: "error" }> => e.type === "error",
  );

  const log: RequestLog =
    outcome?.log() ??
    newCompletedRequestLog(id, at, { requestedModel: input.request.model, status: 0 });
  if (!log.degradations.includes(CLASSIFIER_NOTE)) log.degradations.push(CLASSIFIER_NOTE);
  // Dispatch reads the composed signal, so it files the timeout as a client
  // abort. The row says what happened instead: this gateway's own deadline.
  const assign = (status: number, errorCode: string): void => {
    log.status = status;
    log.errorCode = errorCode;
    log.durationMs = deps.now() - at;
  };
  if (cancelled) {
    if (log.status === 0) assign(499, "interrupted");
  } else if (timedOut) {
    if (log.status === 0 || log.errorCode === "interrupted") assign(504, "TIMEOUT");
  } else if (thrown !== null && log.status === 0) {
    const code =
      thrown.error instanceof GatewayError ? thrown.error.code : ("INTERNAL" as ErrorCode);
    assign(HTTP_STATUS[code], code);
  }
  await finishLog(
    deps.store,
    log,
    input.apiKeyId,
    deps.logger,
    undefined,
    input.debit,
    deps.emit,
    deps.broadcaster,
    deps.telemetry,
    null,
  );

  if (cancelled) return { kind: "cancelled" };
  if (timedOut) return { kind: "failed", reason: "classifier timed out" };
  if (thrown !== null) {
    // What dispatch throws can carry text this gateway did not write — an
    // upstream's body, a store's row — so a provider-bearing message passes
    // the same gate as every rejection line, and anything else is named by
    // code alone.
    const { error } = thrown;
    if (!(error instanceof GatewayError)) {
      return { kind: "failed", reason: "classifier call failed", code: "INTERNAL" };
    }
    const { reason = "classifier call failed" } = reasonField(error, deps.logger);
    return { kind: "failed", reason, code: error.code };
  }
  if (failure !== undefined)
    return { kind: "failed", reason: `classifier ${failure.code}`, code: failure.code };
  const verdict = parseVerdict(collect(events));
  if (verdict === null) return { kind: "failed", reason: "classifier reply unreadable" };
  return { kind: "verdict", verdict };
}

/**
 * Judges one request from a key that carries a usage policy.
 *
 * **Fail closed.** Only an unambiguous allow lets the request through; a deny,
 * a timeout, an error, an unreadable reply, and an unset classifier model all
 * refuse it, with three codes an operator can tell apart. Pinned by
 * `apps/gateway/test/guardrail/proxy.test.ts`.
 */
export async function judge(
  deps: GuardrailDeps,
  input: {
    apiKeyId: string;
    policy: string;
    request: ChatRequest;
    signal: AbortSignal;
    debit: UsageDebit;
    parentRequestId: string;
  },
): Promise<GuardrailOutcome> {
  const { settings } = await deps.snapshots.get(deps.now());
  const model = settings.guardrailModel;
  if (model === null) {
    return {
      kind: "refused",
      error: refusal("INTERNAL", UNCONFIGURED_MESSAGE),
      notes: ["guardrail:unconfigured"],
    };
  }

  const judged = judgedText(input.request);
  const notes = (what: string): string[] =>
    judged.truncated ? [`guardrail:${what}`, "guardrail:truncated"] : [`guardrail:${what}`];
  const decided = (verdict: Verdict): GuardrailOutcome =>
    verdict === "allow"
      ? { kind: "allowed", notes: notes("allowed") }
      : {
          kind: "refused",
          error: refusal("CONTENT_FILTER", REFUSED_MESSAGE),
          notes: notes("denied"),
        };

  const key = verdictKey({
    apiKeyId: input.apiKeyId,
    policy: input.policy,
    model,
    system: judged.system,
    human: judged.human,
  });
  const cached = deps.cache.get(key, deps.now());
  // A hit writes no classifier row and costs nothing.
  if (cached !== undefined) return decided(cached);

  const result = await callClassifier(deps, {
    apiKeyId: input.apiKeyId,
    request: classifierRequest(model, input.policy, judged),
    signal: input.signal,
    timeoutMs: settings.guardrailTimeoutMs,
    debit: input.debit,
  });
  if (result.kind === "cancelled") return result;
  if (result.kind === "failed") {
    // Gateway-authored reasons only: never the classifier's reply, the policy,
    // or the judged text. The parent's own rejection line follows.
    const fields: LogFields = {
      requestId: input.parentRequestId,
      model,
      ...(result.code === undefined ? {} : { code: result.code }),
      reason: result.reason,
    };
    deps.logger.warn("usage policy check failed", fields);
    return {
      kind: "refused",
      error: refusal("UPSTREAM", UNAVAILABLE_MESSAGE),
      notes: notes("unavailable"),
    };
  }
  // Allow and deny alike; a failure is never cached, because the next turn's
  // retry may succeed.
  deps.cache.set(key, result.verdict, deps.now());
  return decided(result.verdict);
}

/**
 * A dispatch whose first step is the judge.
 *
 * Streaming routes send their head and start keepalives at once, so judging
 * inside the event sequence lets those keepalives cover the classifier's
 * latency — `/v1/responses` clients abandon a connection silent for ~5s — and a
 * refusal arrives the way every other pre-commit failure does: an in-stream
 * `error` event on a 200. The non-streaming path drains the same sequence and
 * renders the error with its status. One mechanism, both paths.
 *
 * `log()` is the one row the route completes, exactly once, in every outcome:
 * dispatch's own live log with the guardrail notes added on the allow path, or
 * this wrapper's own log carrying the refusal. A client that hangs up during the
 * check makes the sequence throw its signal's reason, which every route path
 * already records as a disconnect rather than a failure.
 */
export function judgeFirst(opts: {
  judge: () => Promise<GuardrailOutcome>;
  dispatch: () => Promise<DispatchOutcome>;
  signal: AbortSignal;
  requestId: string;
  startedAt: number;
  requestedModel: string;
  now: () => number;
  logger: Logger;
  surface: LogFields["surface"];
}): DispatchOutcome {
  const own = newCompletedRequestLog(opts.requestId, opts.startedAt, {
    requestedModel: opts.requestedModel,
    status: 0,
  });
  let inner: DispatchOutcome | null = null;
  let notes: readonly string[] = [];
  const noted = (log: RequestLog): RequestLog => {
    for (const note of notes) if (!log.degradations.includes(note)) log.degradations.push(note);
    return log;
  };

  /**
   * The judge failing in itself — a settings read that throws — is a check that
   * could not run, and refuses exactly as one that timed out does: the parent
   * row still says which guardrail outcome it was. Its message stays off
   * stdout; it is a store's or a dependency's, never this gateway's.
   */
  async function judged(): Promise<GuardrailOutcome> {
    try {
      return await opts.judge();
    } catch {
      if (opts.signal.aborted) return { kind: "cancelled" };
      opts.logger.warn("usage policy check failed", {
        requestId: opts.requestId,
        reason: "usage policy check threw",
      });
      return {
        kind: "refused",
        error: refusal("UPSTREAM", UNAVAILABLE_MESSAGE),
        notes: ["guardrail:unavailable"],
      };
    }
  }

  async function* events(): AsyncGenerator<StreamEvent, void, undefined> {
    const outcome = await judged();
    if (outcome.kind === "cancelled") throw opts.signal.reason;
    notes = outcome.notes;
    if (outcome.kind === "refused") {
      const { error } = outcome;
      own.status = HTTP_STATUS[error.code];
      own.errorCode = error.code;
      own.durationMs = opts.now() - opts.startedAt;
      noted(own);
      reportRejection(opts.logger, opts.requestId, own, error, opts.surface);
      yield {
        type: "error",
        code: error.code,
        message: error.message,
        retryable: RETRYABLE[error.code],
      };
      return;
    }
    inner = await opts.dispatch();
    yield* inner.events;
  }

  return {
    events: events(),
    log: () => (inner === null ? noted(own) : noted(inner.log())),
  };
}
