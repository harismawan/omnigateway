import { type ErrorCode, GatewayError, type ProviderId } from "@omni/ir";

/** Substrings that identify a transport failure across Bun and undici. */
const NETWORK_HINTS = [
  "fetch failed",
  "econnrefused",
  "econnreset",
  "enotfound",
  "etimedout",
  "socket hang up",
  "unable to connect",
];

/**
 * Turns anything thrown during an attempt into canonical facts.
 *
 * `provider` rides along because it is the only record of who wrote the
 * message, and dispatch re-wraps an attempt's error into a fresh `GatewayError`
 * before anything logs it. Dropping the field there left the redaction gate
 * asking a question nothing could answer — every re-wrapped upstream error
 * looked gateway-authored. It stays absent for everything raised without an
 * upstream in hand — but it is no longer only `httpError` that sets it: codec
 * errors name their provider too, because that is what makes them actionable.
 * Whether a message may be printed is a separate question, and
 * `GatewayError.quotesUpstream` is where it is now asked.
 */
export function classify(error: unknown): {
  code: ErrorCode;
  retryAfterMs?: number;
  provider?: ProviderId;
  /**
   * Carried for the same reason `provider` is: the gate reads it, and a re-wrap
   * that drops it turns a gateway-authored message back into a withheld one.
   * Only ever `true` here — an error this function builds from something that is
   * not a `GatewayError` has a message assembled by `describeError`, and that
   * one quotes whatever the thrown value said.
   */
  gatewayAuthored?: boolean;
} {
  if (error instanceof GatewayError) {
    return {
      code: error.code,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(error.provider === undefined ? {} : { provider: error.provider }),
      ...(error.gatewayAuthored ? { gatewayAuthored: true } : {}),
    };
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "TIMEOUT" };
  }

  // `autoSelectFamily` is on by default, so node tries every address a host
  // resolves to and reports total failure as an `AggregateError`. Its own message
  // is empty and each address's error is in `errors`, so matching the message
  // alone saw `""` and filed a retryable transport failure as this gateway's own
  // defect — which `RETRYABLE` marks non-retryable, ending the request after one
  // attempt with a 500. The first recognised cause decides; an aggregate of
  // things this gateway does not recognise is still INTERNAL.
  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    for (const inner of error.errors) {
      const classified = classify(inner);
      if (classified.code !== "INTERNAL") return classified;
    }
    return { code: "INTERNAL" };
  }

  if (error instanceof Error) {
    const text = `${error.name} ${error.message}`.toLowerCase();
    if (NETWORK_HINTS.some((hint) => text.includes(hint))) return { code: "NETWORK" };
  }

  return { code: "INTERNAL" };
}
