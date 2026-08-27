import { expect, test } from "bun:test";
import type { ServingAccount, TargetAddress } from "../src/types.ts";
import { servesTarget } from "../src/types.ts";

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

test("a target naming no endpoint is served by any account of its provider", () => {
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
 * such a target is served only by an account that matches it. `sqlite/config.ts`
 * reads targets back with `JSON.parse` and no validation, so a restored or
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
 * on the custom arm and `putModel` independently refuses one with no live
 * endpoint — but `sqlite/config.ts` parses stored targets without validation, so
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
 * `providerData` is `Record<string, unknown>` and `sqlite/credentials.ts` reads
 * it back with a bare `JSON.parse`, so `endpointId` can hold any JSON value.
 *
 * These exist because the commit that fixed this shipped **no test at all**, and
 * reverting it passed the entire suite. A present-but-uncomparable id must match
 * nothing — not read as "no endpoint", which is how a custom target naming none
 * came to be served by any account whose id was a number or an object.
 */
const CORRUPT: readonly unknown[] = [0, 42, null, false, {}, [], ["endpoint-a"]];

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

test("two identically corrupt endpoint ids still do not match each other", () => {
  // The case a single hoisted sentinel would get wrong: it would make every
  // corrupt value equal every other, which is looser than the rule this
  // replaced — that one compared raw values, so `42 !== {}` refused. A shared
  // sentinel passes every other test in this file, so without this one the
  // difference between "matches nothing" and "matches anything corrupt" is
  // unpinned.
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
});
