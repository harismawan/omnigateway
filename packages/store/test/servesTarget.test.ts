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
test("an empty endpoint id names no endpoint, and does not narrow anything", () => {
  const t = target({ provider: "anthropic", endpointId: "" });
  expect(servesTarget(t, account({ provider: "anthropic", providerData: {} }))).toBe(true);
  expect(
    servesTarget(t, account({ provider: "anthropic", providerData: { endpointId: "one" } })),
  ).toBe(true);
});
