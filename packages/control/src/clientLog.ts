import type { RequestLog } from "@omni/store";

/**
 * One of the caller's own requests, with the operator's infrastructure removed.
 *
 * `RequestLog` is the operator's row and names the account that served the
 * request. A key holder is entitled to know what they sent, what it cost and
 * whether it worked.
 *
 * What this still protects is **per-request attribution**, and only that. The
 * accounts themselves are no longer hidden — `accountQuota` publishes every
 * account's id and the operator's own label for it, by decision — so the fact
 * kept back here is narrower than it once was: which account served *this*
 * request, on this row, at this instant. That is a traffic-analysis surface the
 * quota panel does not open, and it is why `isClientVisibleDegradation` drops
 * `excluded:*` as well.
 *
 * An earlier version of this note claimed the client was not entitled to know
 * how many accounts the operator runs, and cited `providerHeadroom` as drawing
 * the same line. Both halves are now false: that function is gone, and the
 * surface that replaced it names the accounts. Left recorded because a
 * justification that has quietly stopped being true is worse than none.
 *
 * A projection rather than a `delete` on the row: the fields are enumerated, so
 * a column added to `RequestLog` later is absent here until somebody decides it
 * belongs. The opposite shape — copy everything, remove three keys — hands every
 * future column to the client by default.
 */
export type ClientRequestLog = {
  id: string;
  state: RequestLog["state"];
  at: number;
  requestedModel: string;
  /** Which provider served it. The *account* is deliberately not here. */
  resolvedProvider: RequestLog["resolvedProvider"];
  /** Null while a request is in flight: nothing has been routed to yet. */
  resolvedModel: string | null;
  attempts: number;
  status: number;
  errorCode: RequestLog["errorCode"];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  ttftMs: number | null;
  durationMs: number;
  costUsd: number;
  degradations: string[];
  rtkApplied: boolean;
  rtkEstimatedTokensSaved: number;
};

/**
 * Whether a degradation is safe to show the holder of the key that caused it.
 *
 * Everything except `excluded:*`, and that exclusion is total rather than a
 * redaction of the id inside it.
 *
 * `dispatch` writes two shapes down the same column — `excluded:<id>:<reason>`
 * for a skipped account and `excluded:<reason>` when no account is named — and
 * `reason` is an open `string` that may itself contain a colon
 * (`capability:anthropicTools`, `pin:missing`). Nothing in the stored value
 * distinguishes the two, so no parse can be right for both: splitting on the
 * second colon turns `excluded:capability:anthropicTools` into
 * `excluded:anthropicTools`, and not splitting leaves the id on the wire.
 *
 * Given the choice between a parse that is sometimes wrong about a credential
 * id and dropping a line, the line goes. `excluded:*` is routing diagnostics
 * about which of the *operator's* accounts were skipped — it was never the
 * client's answer to anything. What a client is owed is what happened to their
 * own request, and that is every other degradation: `anthropic:*` capability
 * losses, cache markers, RTK notes. Those name a capability, never an account.
 */
export function isClientVisibleDegradation(entry: string): boolean {
  return !entry.startsWith("excluded:");
}

/** Projects an operator's row down to what its own key holder may see. */
export function toClientLog(log: RequestLog): ClientRequestLog {
  return {
    id: log.id,
    state: log.state,
    at: log.at,
    requestedModel: log.requestedModel,
    resolvedProvider: log.resolvedProvider,
    resolvedModel: log.resolvedModel,
    attempts: log.attempts,
    status: log.status,
    errorCode: log.errorCode,
    inputTokens: log.inputTokens,
    outputTokens: log.outputTokens,
    cacheReadTokens: log.cacheReadTokens,
    cacheWriteTokens: log.cacheWriteTokens,
    ttftMs: log.ttftMs,
    durationMs: log.durationMs,
    costUsd: log.costUsd,
    degradations: log.degradations.filter(isClientVisibleDegradation),
    rtkApplied: log.rtkApplied,
    rtkEstimatedTokensSaved: log.rtkEstimatedTokensSaved,
  };
}
