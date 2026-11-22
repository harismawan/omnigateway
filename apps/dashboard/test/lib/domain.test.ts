import { expect, test } from "bun:test";
import type { ApiKey } from "../../src/api/types.ts";
import {
  durationFor,
  keyUsable,
  type QuotaBurnReading,
  quotaRolledOver,
  quotaVerdict,
  SAME_WINDOW_TOLERANCE_MS,
  type ServingAccount,
  sameWindow,
  servesTarget,
  type TargetAddress,
  WINDOW_DURATION_MS,
} from "../../src/lib/domain.ts";

/**
 * The console's copies of the gateway's single-copy rules. The Rust owners
 * are named on each function in `src/lib/domain.ts`, with the Rust test that
 * pins them:
 *
 * - `keyUsable` → `ApiKey::usable`, `crates/omni-store/tests/key_mutations.rs`
 * - `servesTarget` → `serves_target`, `crates/omni-router/tests/filters.rs`
 * - `quotaRolledOver` → `rolled_over`, `crates/omni-router/tests/quota_breaker_resolve.rs`
 * - `durationFor` → `duration_for` / `WindowType::nominal_ms`, `crates/omni-router/src/quota.rs`
 * - `sameWindow` → the `<=60000` dedupe in `crates/omni-control/src/quota_ops.rs`
 * - `quotaVerdict` → the verdict branch of `crates/omni-cli/src/quota.rs`
 */

const NOW = 1_700_000_000_000;

test("a window is rolled over once its own reset is behind us", () => {
  // The row is overwritten by the poller and by nothing else, so between the
  // reset and the next probe it describes a window that has already ended.
  expect(quotaRolledOver({ resetsAt: NOW - 1 }, NOW)).toBe(true);
  expect(quotaRolledOver({ resetsAt: NOW }, NOW)).toBe(true);
  expect(quotaRolledOver({ resetsAt: NOW + 1 }, NOW)).toBe(false);
});

test("a window with no stated reset is never rolled over", () => {
  // Nothing was said about when it ends, which is not the same as having ended.
  // Reading it as rolled over would suppress every figure for a provider that
  // simply does not report a reset.
  expect(quotaRolledOver({ resetsAt: null }, NOW)).toBe(false);
});

test("a provider-reported duration outranks the nominal one", () => {
  // Codex buckets a three-hour window under the `fiveHour` name. Inferring the
  // window start from the nominal five hours would place it two hours too
  // early and understate everything measured against it.
  expect(durationFor("fiveHour", 3 * 60 * 60 * 1000)).toBe(3 * 60 * 60 * 1000);
  expect(durationFor("weekly", 24 * 60 * 60 * 1000)).toBe(24 * 60 * 60 * 1000);
});

test("a window with no reported duration falls back to the nominal one", () => {
  expect(durationFor("fiveHour", null)).toBe(WINDOW_DURATION_MS.fiveHour);
  expect(durationFor("daily", null)).toBe(WINDOW_DURATION_MS.daily);
  expect(durationFor("weekly", null)).toBe(WINDOW_DURATION_MS.weekly);
});

test("a non-positive reported duration is not believed", () => {
  // A zero-length window is not a window; dividing an elapsed span by it would
  // manufacture an infinite rate out of a bad reading.
  expect(durationFor("fiveHour", 0)).toBe(WINDOW_DURATION_MS.fiveHour);
  expect(durationFor("fiveHour", -1)).toBe(WINDOW_DURATION_MS.fiveHour);
});

test("the nominal durations are the windows the store names", () => {
  expect(WINDOW_DURATION_MS).toEqual({
    fiveHour: 5 * 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
  });
});

test("a reset time that drifted by a fraction of a second is the same window", () => {
  // The reproduction case: a provider that reports a whole-second countdown has
  // its absolute reset derived as `now + seconds * 1000`, and `now` moves a poll
  // interval between probes. Nothing rolled over; the arithmetic jittered.
  expect(sameWindow(1_700_000_000_000, 1_700_000_000_137)).toBe(true);
  expect(sameWindow(1_700_000_000_137, 1_700_000_000_000)).toBe(true);
  expect(sameWindow(1_700_000_000_000, 1_700_000_002_400)).toBe(true);
});

test("a reset time that moved by a whole window is a different window", () => {
  const at = 1_700_000_000_000;
  expect(sameWindow(at, at + WINDOW_DURATION_MS.fiveHour)).toBe(false);
  expect(sameWindow(at, at + WINDOW_DURATION_MS.weekly)).toBe(false);
});

test("the tolerance sits far above the jitter and far below the shortest window", () => {
  // Both margins are what make the threshold unambiguous rather than tuned: a
  // rollover cannot hide under it, and jitter cannot escape it.
  expect(SAME_WINDOW_TOLERANCE_MS).toBeGreaterThanOrEqual(10_000);
  expect(SAME_WINDOW_TOLERANCE_MS * 10).toBeLessThan(WINDOW_DURATION_MS.fiveHour);
  expect(sameWindow(0, SAME_WINDOW_TOLERANCE_MS)).toBe(true);
  expect(sameWindow(0, SAME_WINDOW_TOLERANCE_MS + 1)).toBe(false);
});

test("an unstated reset matches only another unstated reset", () => {
  // Null is not near anything: a provider that started or stopped naming a reset
  // said something new, and that is a reading worth keeping.
  expect(sameWindow(null, null)).toBe(true);
  expect(sameWindow(null, 1_700_000_000_000)).toBe(false);
  expect(sameWindow(1_700_000_000_000, null)).toBe(false);
});

const reading = (patch: Partial<QuotaBurnReading> = {}): QuotaBurnReading => ({
  ratePerHour: 10,
  exhaustsAt: 1_700_000_000_000,
  survives: true,
  stale: false,
  ...patch,
});

const observed = { observedAt: 1_699_000_000_000, limit: 100 };

test("a window that outlives its reset is ok", () => {
  expect(quotaVerdict(observed, reading())).toBe("ok");
});

test("a window that runs out first is empty", () => {
  expect(quotaVerdict(observed, reading({ survives: false }))).toBe("empty");
});

test("no ceiling is unknown, never a claim that the window lasts", () => {
  // `survives` is true by construction whenever there is no `exhaustsAt`, which
  // includes having no limit at all. Reading it directly turns "the provider
  // reported no ceiling" into "you will not run out".
  expect(quotaVerdict({ ...observed, limit: null }, reading({ exhaustsAt: null }))).toBe("unknown");
});

/**
 * A ceiling of zero or below is a ceiling nobody stated.
 *
 * Nothing validates what a provider reports on its way into `quota_windows`,
 * and every other site of this rule already says `limit <= 0` — `usedRatioOf`,
 * `rateRatioOf`, `burnFor`, the CLI's rate column, `reportedWindows`. This was
 * the one that checked `=== null` alone, so `burnFor` returning the suppressed
 * `survives: true` for such a row fell through to the last line and answered
 * **"ok"**: an affirmative safety claim about a window nothing is known about,
 * printed by `omni quota` beside a used column reading `10/0`.
 */
test("a non-positive ceiling is unknown, whichever way it is wrong", () => {
  for (const limit of [0, -5]) {
    expect({
      limit,
      verdict: quotaVerdict({ ...observed, limit }, reading({ exhaustsAt: null })),
    }).toEqual({ limit, verdict: "unknown" });
  }
});

test("no inferable rate is unknown, never a claim that the window lasts", () => {
  expect(quotaVerdict(observed, reading({ ratePerHour: null, exhaustsAt: null }))).toBe("unknown");
});

test("a never-observed window is unknown and an aged one is stale", () => {
  // Two different things to go and fix: nothing has ever been read, versus a
  // reading that has stopped being refreshed.
  const suppressed = reading({ ratePerHour: null, exhaustsAt: null, survives: null, stale: true });
  expect(quotaVerdict({ ...observed, observedAt: 0 }, suppressed)).toBe("unknown");
  expect(quotaVerdict(observed, suppressed)).toBe("stale");
});

test("a missing estimate is unknown", () => {
  expect(quotaVerdict(observed, undefined)).toBe("unknown");
});

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "k1",
    label: "k1",
    prefix: "sk-omni-cccc",
    hash: "a".repeat(64),
    modelAllowlist: null,
    limits: {},
    bodyLoggingOptOut: false,
    createdAt: 0,
    revokedAt: null,
    expiresAt: null,
    guardrailPolicy: null,
    smartRouting: false,
    ...overrides,
  };
}

test("a key with no expiry is usable, and revocation still refuses one", () => {
  expect(keyUsable(key(), NOW)).toBe(true);
  expect(keyUsable(key({ revokedAt: 1 }), NOW)).toBe(false);
});

/**
 * The boundary, stated as an instant rather than a range.
 *
 * `expiresAt === now` is expired: the stored value is when the key stops being
 * accepted, so the instant it names is already outside. A `>=` here would leave
 * one millisecond in which a key that has expired still serves, and that
 * millisecond is exactly what a test written against `Date.now()` would never
 * observe.
 */
test("expiry is exclusive at its own instant", () => {
  expect(keyUsable(key({ expiresAt: NOW - 1 }), NOW)).toBe(false);
  expect(keyUsable(key({ expiresAt: NOW }), NOW)).toBe(false);
  expect(keyUsable(key({ expiresAt: NOW + 1 }), NOW)).toBe(true);
});

/**
 * Both clauses, not either.
 *
 * A revoked key whose expiry is still ahead is the case a one-clause rewrite
 * would serve, and it is the one an operator is most likely to create: revoking
 * a key that also carried an expiry.
 */
test("revoked and unexpired is still unusable", () => {
  expect(keyUsable(key({ revokedAt: 1, expiresAt: NOW + 60_000 }), NOW)).toBe(false);
  expect(keyUsable(key({ revokedAt: 1, expiresAt: NOW - 60_000 }), NOW)).toBe(false);
});

const account = (over: Partial<ServingAccount> = {}): ServingAccount => ({
  id: "acc",
  provider: "custom",
  providerData: {},
  ...over,
});

const target = (over: Partial<TargetAddress> = {}): TargetAddress => ({
  provider: "custom",
  ...over,
});

/**
 * `servesTarget` is the single copy of "can this account serve this target".
 * CLAUDE.md records why: five sites once asked it separately, three asked less
 * than the router did, and a target pinned to another provider's account saved
 * clean, hard-failed every request and was reported healthy by `doctor`.
 *
 * These pin the endpoint rule specifically, which stopped naming `custom` and
 * now keys on the target naming an endpoint at all.
 */
test("a provider mismatch is refused before anything else is considered", () => {
  expect(servesTarget(target({ provider: "anthropic" }), account({ provider: "custom" }))).toBe(
    false,
  );
});

test("a custom target is served only by an account at the same endpoint", () => {
  const t = target({ endpointId: "one" });
  expect(servesTarget(t, account({ providerData: { endpointId: "one" } }))).toBe(true);
  expect(servesTarget(t, account({ providerData: { endpointId: "two" } }))).toBe(false);
  expect(servesTarget(t, account({ providerData: {} }))).toBe(false);
});

test("a target naming no endpoint is served by an account that names none either", () => {
  const t = target({ provider: "anthropic" });
  const a = account({ provider: "anthropic", providerData: { deviceId: "d" } });
  expect(servesTarget(t, a)).toBe(true);
});

/**
 * The one behaviour change in generalising this rule, and it is on data the
 * control schema cannot produce.
 *
 * The check used to read `target.provider === "custom" && …`, so an `endpointId`
 * on a non-custom target was ignored. It now keys on the field being present, so
 * such a target is served only by an account that matches it.
 * `crates/omni-store/src/models.rs` reads targets back with no schema check, so a restored or
 * hand-edited database is exactly where this arises — and failing closed on a
 * constraint the row states is the safer direction than serving it from an
 * account that does not meet it.
 */
test("an endpoint named on a non-custom target is enforced, not ignored", () => {
  const t = target({ provider: "anthropic", endpointId: "one" });
  expect(servesTarget(t, account({ provider: "anthropic", providerData: {} }))).toBe(false);
  expect(
    servesTarget(t, account({ provider: "anthropic", providerData: { endpointId: "one" } })),
  ).toBe(true);
});

test("a pin narrows to one account, on top of every other check", () => {
  const t = target({ endpointId: "one", credentialId: "acc" });
  const matching = account({ id: "acc", providerData: { endpointId: "one" } });
  const sibling = account({ id: "other", providerData: { endpointId: "one" } });
  expect(servesTarget(t, matching)).toBe(true);
  expect(servesTarget(t, sibling)).toBe(false);
});

/**
 * The regression that caught the first version of the endpoint rule.
 *
 * `TargetDraft.endpointId` in the console is a non-optional string and holds
 * `""` for every non-custom target, and the control schema refuses `""` on the
 * way in because it is an id nothing matches rather than a third state. A rule
 * that read `""` as a value to match made this function disagree with the pin
 * picker that calls it, and the picker offered no account for any non-custom
 * target — while the store's own tests stayed green, because none of them spelled
 * "none" that way.
 */
test("an empty endpoint id names no endpoint", () => {
  // The case the pin picker actually asks about: a non-custom target as the
  // console spells it, against an ordinary account of that provider.
  const t = target({ provider: "anthropic", endpointId: "" });
  expect(servesTarget(t, account({ provider: "anthropic", providerData: {} }))).toBe(true);
});

/**
 * ...and the account side does not, which is the asymmetry the two helpers
 * exist for.
 *
 * One shared mapping is what shipped, and it read an account's `""` as "bound to
 * no endpoint" — so a malformed custom account served every target that named
 * none, and a pin to it resolved. Both directions are asserted, because a
 * mapping that refuses only one of them still lets the pair match through the
 * other.
 */
test("an account carrying an empty endpoint id serves nothing", () => {
  const blank = account({ id: "acc", providerData: { endpointId: "" } });
  expect(servesTarget({ provider: "custom" }, blank)).toBe(false);
  expect(servesTarget({ provider: "custom", endpointId: "" }, blank)).toBe(false);
  expect(servesTarget({ provider: "custom", credentialId: "acc" }, blank)).toBe(false);
  // An account with no endpoint at all is the shape that *does* match a target
  // naming none — the positive control that keeps the assertions above from
  // passing for the wrong reason.
  expect(servesTarget({ provider: "custom" }, account({ providerData: {} }))).toBe(true);
});

/**
 * The regression an adversarial review caught, and the reason this rule is an
 * equality in both directions rather than a one-sided check.
 *
 * The first generalisation asked only "does the target name an endpoint the
 * account fails to match". A `custom` target whose `endpointId` was absent or
 * `""` skipped that check and was then served by *every* custom account. The
 * rule it replaced compared `"endpoint-a" !== undefined`, refused, and left the
 * row unroutable.
 *
 * Write paths cannot mint such a row — the control schema requires `endpointId`
 * on the custom arm and model writes in `crates/omni-control` independently
 * refuse one with no live endpoint — but `crates/omni-store/src/models.rs`
 * parses stored targets without schema validation, so
 * a restore or a hand edit supplies one. The consequence was not a failed
 * request: it was a request sent to an arbitrary endpoint's origin with that
 * endpoint's key, and an `omni doctor` that called the pin healthy. That is the
 * inverse of the bug this function was made the single copy for.
 */
test("a custom target naming no endpoint is served by nobody", () => {
  const real = account({ providerData: { endpointId: "endpoint-a" } });
  expect(servesTarget({ provider: "custom" }, real)).toBe(false);
  expect(servesTarget({ provider: "custom", endpointId: "" }, real)).toBe(false);
});

test("a custom target naming no endpoint is not rescued by a pin either", () => {
  // The pin is applied after the endpoint check, so an unroutable row stays
  // unroutable rather than the pin acting as an override.
  const real = account({ id: "acc", providerData: { endpointId: "endpoint-a" } });
  expect(servesTarget({ provider: "custom", credentialId: "acc" }, real)).toBe(false);
});

test("an account bound to an endpoint refuses a target that names none", () => {
  // The other direction of the same equality. Unreachable through the schema for
  // a non-custom provider, and failing closed is the right answer for a
  // credential that states where it points at a target that does not.
  const bound = account({ provider: "anthropic", providerData: { endpointId: "stray" } });
  expect(servesTarget({ provider: "anthropic" }, bound)).toBe(false);
});

/**
 * `providerData` is `Record<string, unknown>` and `crates/omni-store/src/credentials.rs`
 * reads it back as untyped JSON, so `endpointId` can hold any JSON value.
 *
 * These exist because the commit that fixed this shipped **no test at all**, and
 * reverting it passed the entire suite. A present-but-uncomparable id must match
 * nothing — not read as "no endpoint", which is how a custom target naming none
 * came to be served by any account whose id was a number or an object.
 *
 * `""` is on this list and was the last one to get there. It is a *string*, so
 * the type-based guard let it through and it was then read as "no endpoint" —
 * serving every target that names none, the exact fail-open the rest of the list
 * closes. Nothing legitimate writes it: custom-credential creation in
 * `crates/omni-control/src/credentials.rs` reads the field through `required`,
 * which refuses empty, and a non-custom account
 * holds no `endpointId` key at all.
 */
const CORRUPT: readonly unknown[] = [0, 42, null, false, {}, [], ["endpoint-a"], ""];

test("an account whose endpoint id is not a string serves no target", () => {
  for (const endpointId of CORRUPT) {
    const corrupt = account({ providerData: { endpointId } });
    // Against a target naming no endpoint: the case that regressed.
    expect(servesTarget({ provider: "custom" }, corrupt)).toBe(false);
    // And against one naming a real endpoint, which it plainly is not at.
    expect(servesTarget({ provider: "custom", endpointId: "endpoint-a" }, corrupt)).toBe(false);
  }
});

test("a pin does not rescue an account whose endpoint id is not a string", () => {
  for (const endpointId of CORRUPT) {
    const corrupt = account({ id: "acc", providerData: { endpointId } });
    expect(servesTarget({ provider: "custom", credentialId: "acc" }, corrupt)).toBe(false);
  }
});

test("a corrupt target id does not match the identically corrupt account id", () => {
  // `crates/omni-store/src/models.rs` parses stored *targets* untyped too, so
  // the same corrupt value can arrive on both sides of the comparison at once —
  // the one case where mapping unusable ids to a shared value would be visibly
  // wrong, since a raw comparison of two equal values matches.
  //
  // This test previously claimed to pin something else: that each unusable id
  // becomes a *fresh* value, "matching nothing including another of its kind".
  // It could not. The compare is target-against-account and never
  // account-against-account, so a hoisted sentinel passed it — and passed the
  // whole suite — while the comment said it was the one thing standing between
  // "matches nothing" and "matches anything corrupt". The refinement is gone;
  // the assertion it was attached to is real and stays.
  for (const endpointId of CORRUPT) {
    const corrupt = account({ providerData: { endpointId } });
    // `endpointId` on the target is typed `string | undefined`, so a corrupt
    // value only reaches it from an unvalidated read. Cast to model that row.
    const target = { provider: "custom", endpointId } as unknown as {
      provider: "custom";
      endpointId?: string;
    };
    expect(servesTarget(target, corrupt)).toBe(false);
  }

  // The positive control the loop above needs: a *usable* id really does match
  // itself on both sides, so "false for every corrupt pair" is not just this
  // function refusing everything.
  const real = account({ providerData: { endpointId: "endpoint-a" } });
  expect(servesTarget({ provider: "custom", endpointId: "endpoint-a" }, real)).toBe(true);
});
