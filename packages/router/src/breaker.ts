import type { ErrorCode } from "@omni/ir";
import type { CredentialHealth, Settings } from "@omni/store";

export type Penalty = "none" | "soft" | "hard";

/**
 * How a failure reflects on the credential.
 *
 * `hard` blames the credential, `soft` parks it briefly, `none` blames the
 * request and leaves health untouched so a malformed prompt cannot walk the
 * whole pool into an open breaker.
 */
export const PENALTY: Readonly<Record<ErrorCode, Penalty>> = {
  AUTH: "hard",
  UPSTREAM: "hard",
  TIMEOUT: "hard",
  NETWORK: "hard",
  MODEL_UNAVAILABLE: "hard",
  RATE_LIMIT: "soft",
  QUOTA_EXHAUSTED: "soft",
  OVERLOADED: "soft",
  BAD_REQUEST: "none",
  CONFLICT: "none",
  CONTENT_FILTER: "none",
  CAPABILITY_MISMATCH: "none",
  // Blames the request's tool names, not the credential — the same credential
  // serves the next request with different tools perfectly well.
  //
  // Unless the message was truthful. A genuine extra-usage exhaustion sends
  // identical text and is indistinguishable from the response, so it lands here
  // too and forfeits both halves of `QUOTA_EXHAUSTED`: the retry against another
  // credential, and the one-hour park below that would have taken it out of the
  // pool. `"soft"` is still the wrong trade — it would park a healthy credential
  // for an hour on every fingerprint refusal, which is the case actually
  // observed — but the cost is real and is not zero. See `isFingerprintRefusal`
  // in `providers/src/anthropic/decode.ts`; repeated refusals on one credential
  // should be read against `quota_windows` before believing the tool-name story.
  FINGERPRINT_REFUSED: "none",
  NO_CANDIDATES: "none",
  ALL_CANDIDATES_FAILED: "none",
  INTERNAL: "none",
};

/** Weight of the newest latency sample. Low enough to ride out one slow call. */
const EWMA_ALPHA = 0.3;
const DEFAULT_RATE_LIMIT_MS = 60_000;
const QUOTA_PARK_MS = 3_600_000;
const MAX_JITTER_MS = 2_000;

export function blankHealth(credentialId: string, model: string): CredentialHealth {
  return {
    credentialId,
    model,
    breakerState: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    rateLimitedUntil: null,
    ewmaTtftMs: null,
    lastUsedAt: null,
  };
}

export function recordSuccess(
  current: CredentialHealth,
  opts: { settings: Settings; now: number; ttftMs: number | null },
): CredentialHealth {
  const ewma =
    opts.ttftMs === null
      ? current.ewmaTtftMs
      : current.ewmaTtftMs === null
        ? opts.ttftMs
        : current.ewmaTtftMs * (1 - EWMA_ALPHA) + opts.ttftMs * EWMA_ALPHA;

  return {
    ...current,
    breakerState: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    rateLimitedUntil: null,
    ewmaTtftMs: ewma,
    lastUsedAt: opts.now,
  };
}

export function recordFailure(
  current: CredentialHealth,
  opts: {
    settings: Settings;
    now: number;
    code: ErrorCode;
    retryAfterMs?: number;
    /** 0..1, injected so the jittered window stays testable. */
    jitter?: number;
  },
): CredentialHealth {
  const penalty = PENALTY[opts.code];
  if (penalty === "none") return current;

  if (penalty === "soft") {
    const base =
      opts.code === "QUOTA_EXHAUSTED"
        ? QUOTA_PARK_MS
        : (opts.retryAfterMs ?? DEFAULT_RATE_LIMIT_MS);
    // Jitter keeps a pool that rate-limited together from resuming together.
    const until = opts.now + base + Math.round((opts.jitter ?? 0) * MAX_JITTER_MS);
    return { ...current, rateLimitedUntil: until, lastUsedAt: opts.now };
  }

  const failures = current.consecutiveFailures + 1;
  // A bad token will not fix itself, and a failed probe means the credential is
  // still down; both open immediately rather than burning the threshold.
  const open =
    opts.code === "AUTH" ||
    current.breakerState === "halfOpen" ||
    failures >= opts.settings.breakerThreshold;

  return {
    ...current,
    consecutiveFailures: failures,
    breakerState: open ? "open" : "closed",
    openedAt: open ? opts.now : current.openedAt,
    lastUsedAt: opts.now,
  };
}
