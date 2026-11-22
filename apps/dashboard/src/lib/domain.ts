import type { ProviderId, QuotaWindow, WindowType } from "../api/types.ts";

/**
 * The console's copies of the gateway's small single-copy rules.
 *
 * The gateway is the Rust one in `crates/`, which a browser bundle cannot
 * import, so each rule here exists twice: this copy and the Rust function named
 * on it. Each is pinned by `test/lib/domain.test.ts` on the cases the Rust test
 * named beside it uses. Change both or neither.
 */

/**
 * Nominal length of each window.
 *
 * Mirrors `WindowType::nominal_ms` in `crates/omni-store/src/quota.rs`.
 */
export const WINDOW_DURATION_MS: Record<WindowType, number> = {
  fiveHour: 5 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/**
 * How long one window actually runs for: a provider's own positive duration
 * outranks the nominal one, and a non-positive one is discarded.
 *
 * Mirrors `duration_for` in `crates/omni-router/src/quota.rs`.
 */
export function durationFor(windowType: WindowType, windowMs: number | null): number {
  return windowMs !== null && windowMs > 0 ? windowMs : WINDOW_DURATION_MS[windowType];
}

/**
 * How far two reported reset times may sit apart and still be one window.
 *
 * A provider stating a whole-second countdown has its absolute reset rederived
 * on every probe, so it jitters by fractions of a second; a real rollover moves
 * it by a whole window. Applied when comparing, never when parsing.
 *
 * Mirrors the `abs(resets_at-?)<=60000` dedupe in
 * `crates/omni-control/src/quota_ops.rs` (and its Postgres twin in
 * `crates/omni-store/src/pg/quota.rs`); the chart and storage must agree on
 * what one window is.
 */
export const SAME_WINDOW_TOLERANCE_MS = 60_000;

/** Whether two reported reset times describe the same window. Null is near nothing. */
export function sameWindow(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= SAME_WINDOW_TOLERANCE_MS;
}

/**
 * Whether a stored reading describes a window that has already ended. A
 * window with no stated reset is never rolled over.
 *
 * Mirrors `rolled_over` in `crates/omni-router/src/quota.rs`.
 */
export function quotaRolledOver(window: { resetsAt: number | null }, now: number): boolean {
  return window.resetsAt !== null && window.resetsAt <= now;
}

/** The fields a burn estimate has to carry to be judged. */
export type QuotaBurnReading = {
  ratePerHour: number | null;
  exhaustsAt: number | null;
  survives: boolean | null;
  stale: boolean;
};

/** What can honestly be said about one window, before it is phrased. */
export type QuotaVerdict = "stale" | "unknown" | "ok" | "empty";

/**
 * Judged on the reading, never on `survives` alone: `survives` is true by
 * construction whenever there is no `exhaustsAt`, and having no ceiling or no
 * inferable rate are two ways to have none. A ceiling of zero or below is one
 * nobody stated.
 *
 * Mirrors the verdict branch in `crates/omni-cli/src/quota.rs` (`omni quota`).
 */
export function quotaVerdict(
  window: Pick<QuotaWindow, "observedAt" | "limit">,
  estimate: QuotaBurnReading | undefined,
): QuotaVerdict {
  if (estimate === undefined) return "unknown";
  // A row written before snapshots existed carries no reading to age.
  if (window.observedAt > 0 && estimate.stale) return "stale";
  if (estimate.ratePerHour === null || window.limit === null || window.limit <= 0) {
    return "unknown";
  }
  if (estimate.survives === false && estimate.exhaustsAt !== null) return "empty";
  return estimate.survives === true ? "ok" : "unknown";
}

/**
 * Whether this key may still be used at this instant. Expiry is exclusive:
 * `expiresAt === now` is expired.
 *
 * Mirrors `ApiKey::usable` in `crates/omni-store/src/keys.rs`, pinned there by
 * `crates/omni-store/tests/key_mutations.rs`.
 */
export const keyUsable = (
  key: { revokedAt: number | null; expiresAt: number | null },
  now: number,
): boolean => key.revokedAt === null && (key.expiresAt === null || key.expiresAt > now);

/** The credential facts that decide whether an account can serve a target. */
export type ServingAccount = {
  id: string;
  provider: ProviderId;
  providerData: Record<string, unknown>;
};

/** The three fields of a target that decide which accounts can reach it. */
export type TargetAddress = {
  provider: ProviderId;
  endpointId?: string | undefined;
  credentialId?: string | undefined;
};

/** One shared sentinel: the compare is always target-against-account. */
const UNUSABLE = Symbol("unusable-endpoint");

/**
 * Whether this account is one the target could be dispatched to. Provider,
 * custom endpoint and pin are one question.
 *
 * `""` names no endpoint **on the target side only** — the console's draft
 * spells "none" that way. On the account side any present value that is not a
 * non-empty string is a malformed row and matches nothing, so a corrupt row
 * fails closed rather than serving every target that names no endpoint.
 *
 * Mirrors `serves_target` in `crates/omni-router/src/filters.rs`, pinned there
 * by `crates/omni-router/tests/filters.rs`
 * (`the_endpoint_rule_fails_closed_on_malformed_rows`,
 * `pairs_custom_targets_only_with_credentials_for_the_same_endpoint`).
 */
export function servesTarget(target: TargetAddress, account: ServingAccount): boolean {
  if (account.provider !== target.provider) return false;
  const namedByTarget = (value: string | undefined): string | undefined =>
    value === undefined || value === "" ? undefined : value;
  const namedByAccount = (value: unknown): string | symbol | undefined => {
    if (value === undefined) return undefined;
    return typeof value === "string" && value !== "" ? value : UNUSABLE;
  };
  if (namedByTarget(target.endpointId) !== namedByAccount(account.providerData.endpointId)) {
    return false;
  }
  return target.credentialId === undefined || account.id === target.credentialId;
}

/**
 * The log levels in rank order, as the gateway's own output names them.
 *
 * Mirrors `rank` in `crates/omni-cli/src/console.rs` (and the level list in
 * `crates/omni-gateway/src/console.rs`).
 */
export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

/** A level name the gateway writes. */
export type LogLevel = keyof typeof LEVELS;

/**
 * The longest usage policy a key may carry, in characters after trimming.
 *
 * Mirrors the `> 4000` checks in `crates/omni-control/src/keys.rs`, which has
 * no named constant for it.
 */
export const GUARDRAIL_POLICY_MAX_CHARS = 4_000;

/** The ceiling on `Settings.guardrailTimeoutMs`. `crates/omni-store/src/settings.rs`. */
export const GUARDRAIL_TIMEOUT_MAX_MS = 60_000;

/** The longest smart-router policy. `crates/omni-store/src/settings.rs`. */
export const SMART_ROUTER_POLICY_MAX_CHARS = 4_000;

/** The ceiling on `Settings.smartRouterTimeoutMs`. `crates/omni-store/src/settings.rs`. */
export const SMART_ROUTER_TIMEOUT_MAX_MS = 60_000;

/** The ceiling on `Settings.guardrailHistoryTurns`. `crates/omni-store/src/settings.rs`. */
export const GUARDRAIL_HISTORY_TURNS_MAX = 10;

/**
 * What the smart router's classifier is told "confidential" means until the
 * operator writes their own. `crates/omni-store/src/settings.rs` holds the
 * original; the console shows it as the field's starting text.
 */
export const DEFAULT_SMART_ROUTER_POLICY =
  "Personal data: names together with ID numbers, addresses, phone numbers, emails, " +
  "national ID (NIK), passport, bank or card numbers. " +
  "Credentials and secrets: passwords, API keys, tokens, private keys, connection strings. " +
  "Salaries and HR records. Customer or patient records. Non-public financial figures. " +
  "Internal documents marked confidential or internal. Source code marked proprietary.";
