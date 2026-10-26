import type { BodyState, RequestLogWrite } from "./types.ts";

/**
 * `request_logs.body_state` as both stores read and write it, for the reason
 * `traceColumns.ts` is shared: the rule is the contract, and one source cannot
 * disagree with itself. See `RequestLog.bodyState`.
 */

/** Anything unrecognised reads as null, "not attempted": it promises no body. */
export function readBodyState(value: string | null): BodyState | null {
  return value === "pending" || value === "ready" || value === "omitted" || value === "failed"
    ? value
    : null;
}

/**
 * What a log write may ask for: `pending`, or nothing — every later state is the
 * store's. `RequestLogWrite` already says so; this holds for a caller past the type.
 */
export function requestedBodyState(log: RequestLogWrite): "pending" | null {
  return log.bodyState === "pending" ? "pending" : null;
}
