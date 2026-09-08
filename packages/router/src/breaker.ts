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
  };
}

/**
 * The fields `recordSuccess` resets, and so the whole of what a success can
 * change. Everything here is a value routing decides on; measurements live in
 * the gateway's `loadRegistry`, so a success that would change none of these
 * has nothing to write.
 *
 * `consecutiveFailures` is not optional. A sub-threshold hard failure writes a
 * count with the breaker still closed, and the next success is what resets it;
 * a predicate that skipped that success would turn the breaker from counting
 * consecutive failures into counting cumulative ones.
 *
 * The Postgres `config_version` trigger watches a strict subset — the columns
 * whose change forces every replica to rebuild rather than patch. The count is
 * patched, so it is deliberately absent there and present here.
 */
export const SUCCESS_RESETS = [
  "breakerState",
  "consecutiveFailures",
  "openedAt",
  "rateLimitedUntil",
] as const satisfies ReadonlyArray<keyof CredentialHealth>;

/**
 * Whether `recordSuccess` would change this row.
 *
 * No row reads as blank, which is what routing already assumes for it —
 * `healthScore(undefined)` is 1 and the filters admit it — so a success there
 * writes nothing and a healthy account ordinarily has no row at all. Rows
 * come into being on a failure.
 *
 * Read off the snapshot before the attempt, never inside `updateHealth`'s
 * `apply` — that runs inside the transaction this exists to skip.
 */
export function successWouldChange(current: CredentialHealth | undefined): boolean {
  if (current === undefined) return false;
  const blank = blankHealth(current.credentialId, current.model);
  return SUCCESS_RESETS.some((field) => current[field] !== blank[field]);
}

export function recordSuccess(current: CredentialHealth): CredentialHealth {
  return {
    ...current,
    breakerState: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    rateLimitedUntil: null,
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
    return { ...current, rateLimitedUntil: until };
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
  };
}
