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
 * looked gateway-authored. Only `httpError` sets it, so it stays absent for
 * everything this gateway raised itself.
 */
export function classify(error: unknown): {
  code: ErrorCode;
  retryAfterMs?: number;
  provider?: ProviderId;
} {
  if (error instanceof GatewayError) {
    return {
      code: error.code,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(error.provider === undefined ? {} : { provider: error.provider }),
    };
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "TIMEOUT" };
  }

  if (error instanceof Error) {
    const text = `${error.name} ${error.message}`.toLowerCase();
    if (NETWORK_HINTS.some((hint) => text.includes(hint))) return { code: "NETWORK" };
  }

  return { code: "INTERNAL" };
}
