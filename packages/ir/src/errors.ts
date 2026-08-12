import type { ProviderId } from "./request.ts";

/**
 * Every way a request can fail, named once.
 *
 * The set is closed on purpose: the breaker (Task 14) and both error renderers
 * (Task 17) key exhaustive `Record<ErrorCode, ...>` tables off it, so adding a
 * code without deciding its penalty and its wire shape is a type error rather
 * than a silent default.
 *
 * The three groups: the upstream refused (`AUTH` through `MODEL_UNAVAILABLE`),
 * the transport failed (`UPSTREAM`, `TIMEOUT`, `NETWORK`), or the gateway
 * itself has nothing to offer (`NO_CANDIDATES` onward).
 */
export type ErrorCode =
  | "AUTH"
  | "RATE_LIMIT"
  | "QUOTA_EXHAUSTED"
  | "OVERLOADED"
  | "BAD_REQUEST"
  | "CONFLICT"
  | "CONTENT_FILTER"
  | "CAPABILITY_MISMATCH"
  | "MODEL_UNAVAILABLE"
  | "UPSTREAM"
  | "TIMEOUT"
  | "NETWORK"
  | "NO_CANDIDATES"
  | "ALL_CANDIDATES_FAILED"
  | "INTERNAL";

/**
 * Whether dispatch should advance to the next candidate.
 *
 * `AUTH` is retryable because it blames one credential, not the request — the
 * next credential in the pool may well work. `BAD_REQUEST` and `CONTENT_FILTER`
 * are not, because every candidate would reject the same body, and walking the
 * whole pool to prove it just multiplies the latency.
 */
export const RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  AUTH: true,
  RATE_LIMIT: true,
  QUOTA_EXHAUSTED: true,
  OVERLOADED: true,
  MODEL_UNAVAILABLE: true,
  CAPABILITY_MISMATCH: true,
  UPSTREAM: true,
  TIMEOUT: true,
  NETWORK: true,
  BAD_REQUEST: false,
  CONFLICT: false,
  CONTENT_FILTER: false,
  NO_CANDIDATES: false,
  ALL_CANDIDATES_FAILED: false,
  INTERNAL: false,
};

/**
 * HTTP status the client sees.
 *
 * `AUTH` is 401 because the only `AUTH` that reaches a client uncommitted is
 * the gateway's own API-key check (Task 18). An upstream `AUTH` is retryable,
 * so an exhausted pool surfaces as `ALL_CANDIDATES_FAILED`, and the client is
 * never told to go fix a key that was fine.
 */
export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  AUTH: 401,
  RATE_LIMIT: 429,
  QUOTA_EXHAUSTED: 429,
  OVERLOADED: 503,
  BAD_REQUEST: 400,
  CONFLICT: 409,
  CONTENT_FILTER: 400,
  CAPABILITY_MISMATCH: 400,
  MODEL_UNAVAILABLE: 404,
  UPSTREAM: 502,
  TIMEOUT: 504,
  NETWORK: 502,
  NO_CANDIDATES: 503,
  ALL_CANDIDATES_FAILED: 503,
  INTERNAL: 500,
};

export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  /** Which upstream failed, when the failure came from one. */
  readonly provider: ProviderId | undefined;
  /** The upstream's own HTTP status, kept for logs — not what the client sees. */
  readonly upstreamStatus: number | undefined;
  /** Milliseconds, when the upstream sent a Retry-After header. */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: {
      provider?: ProviderId;
      status?: number;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "GatewayError";
    this.code = code;
    this.retryable = RETRYABLE[code];
    this.provider = opts?.provider;
    this.upstreamStatus = opts?.status;
    this.retryAfterMs = opts?.retryAfterMs;
  }
}
