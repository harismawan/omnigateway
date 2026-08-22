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
  | "FINGERPRINT_REFUSED"
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
  // Same reasoning as `BAD_REQUEST`: the refusal is a check on the request's
  // own tool names, so every candidate refuses the identical body and walking
  // the pool buys latency and nothing else.
  FINGERPRINT_REFUSED: false,
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
  // The upstream's own status, forwarded with its own message: the client sees
  // exactly what it saw before this code existed. Only the gateway's record of
  // why improves.
  FINGERPRINT_REFUSED: 400,
  MODEL_UNAVAILABLE: 404,
  UPSTREAM: 502,
  TIMEOUT: 504,
  NETWORK: 502,
  NO_CANDIDATES: 503,
  ALL_CANDIDATES_FAILED: 503,
  INTERNAL: 500,
};

/**
 * What to print when an error has to explain itself in one field.
 *
 * `LogFields.reason` carries `error.message`, and not every error has one:
 * `AggregateError` — how node reports a failed multi-address connect, with
 * `autoSelectFamily` on by default — keeps its detail in `errors` and leaves
 * its own message empty. Copying that verbatim rendered `reason=` with nothing
 * after it, on the lines that exist to explain a failure, and `request_logs`
 * holds no message, so the reason was recoverable from nowhere.
 *
 * The name is not the detail, but it is never empty. `fallback` stays a
 * parameter because each caller knows what it was doing and the generic
 * "unknown" is worse than "could not open the database" at every one of them.
 *
 * Safe for `reason`'s redaction rules: it returns the message the caller would
 * already have passed, or a constructor name, which is a bounded identifier.
 */
export function describeError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.length > 0 ? error.message : error.name;
}

export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  /** Which upstream failed, when the failure came from one. */
  readonly provider: ProviderId | undefined;
  /** The upstream's own HTTP status, kept for logs — not what the client sees. */
  readonly upstreamStatus: number | undefined;
  /** Milliseconds, when the upstream sent a Retry-After header. */
  readonly retryAfterMs: number | undefined;
  /**
   * Capability reductions the failed attempt had already applied.
   *
   * An adapter builds its wire body — and learns what the request lost doing
   * it — before the upstream answers, so a request that is then refused has
   * degradations that exist and are recorded nowhere: they ride out on
   * `AdapterResult`, which a throw never produces. That matters most for a
   * refusal the gateway blames on something it did to the request, where the
   * first question is whether it did that thing at all.
   *
   * **Populated today by exactly one throw site**: the Anthropic tool-name
   * fingerprint refusal, which is the one failure whose diagnosis depends on
   * it. Every other throw — including Anthropic's own non-fingerprint errors,
   * and every other adapter — still discards what it degraded. So an empty
   * array means "nobody attached any here", never "nothing was degraded".
   * Widening that is a change to make deliberately rather than to assume has
   * already happened.
   *
   * Every value is an adapter-authored constant. Unlike `LogFields` this type
   * enforces no vocabulary, and it feeds an operator-facing column, so a
   * caller interpolating request data into an entry would be a privacy change
   * on the same terms as widening `LogFields`.
   */
  readonly degradations: readonly string[];

  constructor(
    code: ErrorCode,
    message: string,
    opts?: {
      provider?: ProviderId;
      status?: number;
      retryAfterMs?: number;
      degradations?: readonly string[];
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
    // Copied, not aliased: `readonly` is a compile-time claim, and the caller's
    // array is a local it may still be pushing to.
    this.degradations = [...(opts?.degradations ?? [])];
  }
}
