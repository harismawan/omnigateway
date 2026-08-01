import { type ErrorCode, GatewayError } from "@omni/ir";

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

/** Turns anything thrown during an attempt into a canonical code. */
export function classify(error: unknown): { code: ErrorCode; retryAfterMs?: number } {
  if (error instanceof GatewayError) {
    return error.retryAfterMs === undefined
      ? { code: error.code }
      : { code: error.code, retryAfterMs: error.retryAfterMs };
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
