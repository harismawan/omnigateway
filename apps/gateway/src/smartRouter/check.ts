import {
  type ChatRequest,
  collect,
  type ErrorCode,
  GatewayError,
  HTTP_STATUS,
  type LogFields,
  type StreamEvent,
} from "@omni/ir";
import { localOnlyModel } from "@omni/router";
import type { RequestLog } from "@omni/store";
import {
  type DispatchDeps,
  type DispatchOutcome,
  dispatch,
  LOCAL_ONLY_MESSAGE,
} from "../dispatch/index.ts";
import type { VerdictCache } from "../guardrail/cache.ts";
import type { GuardrailDeps, ScreenThrew } from "../guardrail/judge.ts";
import { finishLog, newCompletedRequestLog, type UsageDebit } from "../logging.ts";
import { type TraceContext, withTrace } from "../trace/extract.ts";
import { segmentKey } from "./cache.ts";
import {
  type Confidentiality,
  confidentialityRequest,
  parseConfidentiality,
} from "./classifier.ts";
import { segments } from "./extract.ts";

/** A classifier call timed out, failed, or answered something unreadable. `UPSTREAM`, 502. */
export const UNAVAILABLE_MESSAGE = "confidentiality check unavailable";
/**
 * Either model unset, unresolvable, or not local-only. `INTERNAL`, 500. The
 * same words dispatch fails a `localOnly` request with, since it is the same
 * finding made against a later snapshot.
 */
export const UNCONFIGURED_MESSAGE = LOCAL_ONLY_MESSAGE;
/** On the check's one classifier row, the link between it and the request it judged. */
export const CLASSIFIER_NOTE = "smart-router:classifier";

/** Uncached segments classified at once, at most. */
export const SEGMENT_CONCURRENCY = 4;
/** Above this many uncached segments the request goes local without asking (~512k chars). */
export const MAX_UNCACHED_SEGMENTS = 64;

/**
 * Where the request goes. `local` with `model` equal to the request's own is the
 * already-local case: nothing to reroute. `local.classifier` is the classifier
 * model this check validated as local-only, against its own snapshot — the one
 * a guardrail on the same request must use, rather than re-reading settings
 * that may have changed since. `cancelled` is the client hanging up while the
 * check ran — a disconnect, not a failed check.
 */
export type SmartRouteDecision =
  | { kind: "external"; notes: readonly string[] }
  | { kind: "local"; model: string; classifier: string; notes: readonly string[] }
  | { kind: "refused"; error: GatewayError; notes: readonly string[] }
  | { kind: "cancelled" };

export type SmartRouterDeps = Omit<GuardrailDeps, "cache"> & {
  smartRouterCache: VerdictCache<Confidentiality>;
};

/** Fixed and gateway-authored: the classifier's own words never reach the client. */
const refusal = (code: ErrorCode, message: string): GatewayError =>
  new GatewayError(code, message, { gatewayAuthored: true });

/**
 * What a screen that threw refuses with while smart routing is active: the
 * check could not run, so nothing was shown to be public.
 */
export function smartRouterThrew(): ScreenThrew {
  return {
    error: refusal("UPSTREAM", UNAVAILABLE_MESSAGE),
    notes: ["smart-router:unavailable"],
    warning: "confidentiality check failed",
    reason: "confidentiality check threw",
  };
}

const thrownCode = (error: unknown): ErrorCode =>
  error instanceof GatewayError ? error.code : "INTERNAL";

/** Why a check failed. `status`/`errorCode` are what the check's row records. */
type Failure = { reason: string; code?: ErrorCode; status: number; errorCode: string | null };

type CallResult =
  | { kind: "verdict"; verdict: Confidentiality }
  | { kind: "failed"; failure: Failure }
  /** Ended by the client's signal or by the check's own stop: neither failure nor verdict. */
  | { kind: "aborted" };

/**
 * One segment's classifier call. Mirrors the guardrail's `callClassifier` —
 * own request id, no request transforms, `trace: null`, the bare transport —
 * except that it writes **no row**: the check writes one for all its calls, so
 * the call hands its log back instead.
 *
 * Three signals are composed: the client's, the check's shared `stop`, and this
 * call's own timeout. They are told apart afterwards by asking which fired.
 */
async function callSegment(
  deps: SmartRouterDeps,
  input: {
    request: ChatRequest;
    signal: AbortSignal;
    stop: AbortSignal;
    timeoutMs: number;
  },
): Promise<{ result: CallResult; log: RequestLog | null }> {
  const id = deps.requestId();
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(refusal("TIMEOUT", "confidentiality check timed out")),
    input.timeoutMs,
  );
  const signal = AbortSignal.any([input.signal, input.stop, timeout.signal]);

  // The parent's `onRoute` writes the parent's pending row; this call has none.
  const callDeps: DispatchDeps = { ...deps, trace: null };
  delete callDeps.onRoute;

  let outcome: DispatchOutcome | null = null;
  const events: StreamEvent[] = [];
  let thrown: { error: unknown } | null = null;
  try {
    // `localOnly`: the segment is not yet shown to be public, so the call is
    // refused by dispatch itself if the classifier stopped being local-only.
    outcome = await dispatch(input.request, callDeps, signal, id, {
      requestTransforms: false,
      localOnly: true,
    });
    for await (const event of outcome.events) events.push(event);
  } catch (error) {
    thrown = { error };
  } finally {
    clearTimeout(timer);
  }
  const log = outcome?.log() ?? null;
  const failure = events.find(
    (e): e is Extract<StreamEvent, { type: "error" }> => e.type === "error",
  );

  // A verdict that arrived whole is a verdict, whatever fired after it.
  if (thrown === null && failure === undefined) {
    const verdict = parseConfidentiality(collect(events));
    if (verdict !== null) return { result: { kind: "verdict", verdict }, log };
  }
  if (input.signal.aborted || input.stop.aborted) return { result: { kind: "aborted" }, log };

  const status = log?.status ?? 0;
  const errorCode = log?.errorCode ?? null;
  if (timeout.signal.aborted) {
    // Dispatch reads the composed signal, so it files the timeout as a client
    // abort. The row says what happened instead: this gateway's own deadline.
    const own = status === 0 || errorCode === "interrupted";
    return {
      result: {
        kind: "failed",
        failure: {
          reason: "classifier timed out",
          status: own ? 504 : status,
          errorCode: own ? "TIMEOUT" : errorCode,
        },
      },
      log,
    };
  }
  if (thrown !== null) {
    // Named by code alone: what dispatch throws can carry text this gateway did
    // not write. See `guardrail/judge.ts`.
    const code = thrownCode(thrown.error);
    return {
      result: {
        kind: "failed",
        failure:
          status === 0
            ? { reason: "classifier call failed", code, status: HTTP_STATUS[code], errorCode: code }
            : { reason: "classifier call failed", code, status, errorCode },
      },
      log,
    };
  }
  if (failure !== undefined) {
    return {
      result: {
        kind: "failed",
        failure: { reason: `classifier ${failure.code}`, code: failure.code, status, errorCode },
      },
      log,
    };
  }
  return {
    result: {
      kind: "failed",
      failure: { reason: "classifier reply unreadable", status, errorCode },
    },
    log,
  };
}

/**
 * Decides whether a request may go to its external provider, must go to the
 * operator's local model, or is refused.
 *
 * **Fail closed.** Only every segment judged an unambiguous `PUBLIC` sends the
 * request external; any confidential segment, or too many to judge, sends it
 * local; a failed call or a configuration that is not local-only refuses it. It
 * never falls back to an external provider. Leak reduction, not a boundary:
 * see the design's threat model.
 */
export async function checkConfidentiality(
  deps: SmartRouterDeps,
  input: {
    apiKeyId: string;
    request: ChatRequest;
    signal: AbortSignal;
    debit: UsageDebit;
    parentRequestId: string;
    /** The parent's trace, inherited by the check's row. */
    trace?: TraceContext | null;
  },
): Promise<SmartRouteDecision> {
  const snapshot = await deps.snapshots.get(deps.now());
  const { settings } = snapshot;
  const classifier = settings.smartRouterClassifierModel;
  const localModel = settings.smartRouterLocalModel;

  // 1. Both models set and local-only, against this snapshot: a virtual model
  //    can gain an external target after it was configured.
  if (
    classifier === null ||
    localModel === null ||
    localOnlyModel(classifier, snapshot, deps.providers) === null ||
    localOnlyModel(localModel, snapshot, deps.providers) === null
  ) {
    return {
      kind: "refused",
      error: refusal("INTERNAL", UNCONFIGURED_MESSAGE),
      notes: ["smart-router:unconfigured"],
    };
  }

  // 2. Nothing can leak from a request already bound for the operator's own
  //    hardware, so a classifier outage must not refuse it.
  if (localOnlyModel(input.request.model, snapshot, deps.providers) !== null) {
    return {
      kind: "local",
      model: input.request.model,
      classifier,
      notes: ["smart-router:already-local"],
    };
  }

  const local: SmartRouteDecision = {
    kind: "local",
    model: localModel,
    classifier,
    notes: ["smart-router:local"],
  };
  const external: SmartRouteDecision = { kind: "external", notes: ["smart-router:public"] };
  const policy = settings.smartRouterPolicy;

  // 3. Cached verdicts first. A cached confidential decides with no call.
  const uncached: Array<{ key: string; text: string }> = [];
  for (const text of segments(input.request)) {
    const key = segmentKey(classifier, policy, text);
    const cached = deps.smartRouterCache.get(key, deps.now());
    if (cached === "confidential") return local;
    if (cached === undefined) uncached.push({ key, text });
  }
  if (uncached.length > MAX_UNCACHED_SEGMENTS) {
    return { ...local, notes: ["smart-router:local", "smart-router:oversize"] };
  }
  if (uncached.length === 0) return external;

  // 4. Classify, at most SEGMENT_CONCURRENCY at once. Whichever call settles
  //    first with a confidential or a failure decides, and stops the rest.
  const startedAt = deps.now();
  const stop = new AbortController();
  /** Each call's log, indexed by call order, so the row names the first call's target. */
  const logs: Array<RequestLog | undefined> = [];
  /** The first call to settle with a confidential or a failure. Set once. */
  const state: { decided: { kind: "confidential" } | { kind: "failed"; failure: Failure } | null } =
    { decided: null };
  let next = 0;
  let calls = 0;

  const worker = async (): Promise<void> => {
    while (next < uncached.length && !stop.signal.aborted && !input.signal.aborted) {
      const segment = uncached[next++];
      if (segment === undefined) return;
      const index = calls++;
      const { result, log } = await callSegment(deps, {
        request: confidentialityRequest(classifier, policy, segment.text),
        signal: input.signal,
        stop: stop.signal,
        timeoutMs: settings.smartRouterTimeoutMs,
      });
      if (log !== null) logs[index] = log;
      if (result.kind === "verdict") {
        // 5. Both verdicts are cached; failures and stopped calls never are.
        deps.smartRouterCache.set(segment.key, result.verdict, deps.now());
        if (result.verdict === "confidential" && state.decided === null) {
          state.decided = { kind: "confidential" };
          stop.abort();
        }
      } else if (result.kind === "failed" && state.decided === null) {
        state.decided = { kind: "failed", failure: result.failure };
        stop.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEGMENT_CONCURRENCY, uncached.length) }, worker));

  const cancelled = input.signal.aborted;
  // A client gone before the first call: nothing was spent, so no row.
  if (calls === 0 && cancelled) return { kind: "cancelled" };

  // 6. One row for the whole check, only when it called anything.
  const outcome = state.decided;
  const status = cancelled
    ? { status: 499, errorCode: "interrupted" }
    : outcome?.kind === "failed"
      ? { status: outcome.failure.status, errorCode: outcome.failure.errorCode }
      : { status: 200, errorCode: null };
  await finishLog(
    deps.store,
    withTrace(
      checkRow(
        deps.requestId(),
        startedAt,
        deps.now(),
        classifier,
        calls,
        logs.filter((log) => log !== undefined),
        status,
      ),
      input.trace ?? null,
    ),
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
  if (outcome?.kind === "failed") {
    // Gateway-authored reasons only: never the classifier's reply, the policy,
    // or the judged text.
    const { failure } = outcome;
    const fields: LogFields = {
      requestId: input.parentRequestId,
      model: classifier,
      ...(failure.code === undefined ? {} : { code: failure.code }),
      reason: failure.reason,
    };
    deps.logger.warn("confidentiality check failed", fields);
    return {
      kind: "refused",
      error: refusal("UPSTREAM", UNAVAILABLE_MESSAGE),
      notes: ["smart-router:unavailable"],
    };
  }
  // 7.
  return outcome?.kind === "confidential" ? local : external;
}

/**
 * The check's one row: the classifier model as requested, the target of the
 * first call (in call order) that routed, every call's tokens and cost summed — stopped calls included,
 * since what they spent was spent.
 */
function checkRow(
  id: string,
  startedAt: number,
  now: number,
  classifier: string,
  calls: number,
  logs: readonly RequestLog[],
  status: { status: number; errorCode: string | null },
): RequestLog {
  const routed = logs.find((log) => log.resolvedProvider !== null);
  const sum = (
    field: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "costUsd",
  ) => logs.reduce((total, log) => total + log[field], 0);
  return newCompletedRequestLog(id, startedAt, {
    requestedModel: classifier,
    resolvedProvider: routed?.resolvedProvider ?? null,
    resolvedModel: routed?.resolvedModel ?? null,
    credentialId: routed?.credentialId ?? null,
    attempts: calls,
    status: status.status,
    errorCode: status.errorCode,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheWriteTokens: sum("cacheWriteTokens"),
    costUsd: sum("costUsd"),
    durationMs: now - startedAt,
    degradations: [CLASSIFIER_NOTE],
  });
}
