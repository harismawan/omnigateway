import { expect, test } from "bun:test";
import { PROVIDER_IDS } from "@omni/providers/descriptors";
import { PROVIDER_IDS as CONNECT_PROVIDER_IDS } from "../src/connect.ts";
import { oauthProviderIds, seedBuiltinOAuth } from "../src/oauth/index.ts";
import { modelSchema, providerIdSchema } from "../src/schemas.ts";

test("the connect surface knows every provider the registry describes", () => {
  expect([...CONNECT_PROVIDER_IDS].sort()).toEqual([...PROVIDER_IDS].sort());
});

test("providerIdSchema accepts every provider, and any id shaped like one", () => {
  for (const id of PROVIDER_IDS) {
    expect(providerIdSchema.safeParse(id).success).toBe(true);
  }
  // A well-formed id the registry has never heard of passes, and that is the
  // change: the schema was `z.enum(PROVIDER_IDS)`, and `PROVIDER_IDS` is
  // `Object.keys(...)` at import — long before `loadPlugins()` — so a plugin
  // provider's credential would have been refused by a snapshot of the world
  // taken before it existed. Existence is asked at the call site instead; the
  // test below is where the refusal now lives.
  expect(providerIdSchema.safeParse("not-a-provider").success).toBe(true);
});

test("providerIdSchema refuses an id that cannot name a provider", () => {
  // Format is still a real gate. The id becomes a `--p-<id>` custom property, a
  // `plugin_<id>_*` table prefix and a `plugin:<id>:*` topic, so an id that
  // cannot be all three has to fail here rather than wherever noticed first.
  for (const bad of [
    "",
    "Anthropic",
    "1kilo",
    "kilo_code",
    "kilo.code",
    "kilo code",
    "-kilo",
    "a".repeat(33),
  ]) {
    expect(providerIdSchema.safeParse(bad).success).toBe(false);
  }
});

test("every OAuth provider is a provider the registry describes", () => {
  // `OAUTH_PROVIDERS` is empty until a host seeds it, so this seeds rather than
  // relying on another file in the same run having done it. Measured before the
  // seed was added here: run alone the loop body never executed and the test
  // passed green over an empty set — the "green and vacuous" shape this
  // repository keeps an incident file for.
  seedBuiltinOAuth();

  // Assert the walk found something before asserting anything about what it
  // found, the instrument `providerTables.test.ts` already uses.
  expect(oauthProviderIds().length).toBeGreaterThan(0);

  // The reverse does not hold and must not be asserted: `custom` has no
  // authorization to start, and a provider may legitimately be key-only.
  for (const id of oauthProviderIds()) {
    expect(PROVIDER_IDS).toContain(id);
  }
});

/**
 * `targetSchema` **was** a discriminated union whose non-custom arm listed the
 * providers by hand, and this test stood in for derivation: a seventh provider
 * nobody added to an arm failed here rather than being silently unsaveable.
 *
 * That is no longer what it does. The union is gone — it was written for
 * exhaustiveness over a closed `ProviderId`, which no longer exists, and it
 * refused every target naming a plugin-supplied provider. This test now asserts
 * something weaker and still worth having: that each built-in round-trips
 * through the schema, and that `custom` still needs its `endpointId`. **It
 * cannot fail for a seventh provider**, so do not read it as the net that
 * catches one; `packages/providers/test/descriptor.test.ts` is that.
 */
test("every provider round-trips through the target schema", () => {
  const base = {
    model: "a-model",
    tier: 1,
    weight: 1,
    costPerMTok: { input: 1, output: 2 },
    capabilities: { tools: true, images: true, reasoning: true },
  };

  for (const provider of PROVIDER_IDS) {
    // `custom` carries the endpoint id its own arm requires; the others do not
    // have that field at all.
    const target =
      provider === "custom"
        ? { ...base, provider, endpointId: "an-endpoint" }
        : { ...base, provider };

    const result = modelSchema.safeParse({
      id: "a-model-pool",
      strategy: "score",
      isAlias: false,
      targets: [target],
    });
    expect(result.success).toBe(true);
  }
});

test("a custom target with no endpoint id is refused", () => {
  // The reason the `custom` arm exists. If this ever passes, a custom target can
  // be saved that no account can be matched to, and every request for it fails
  // at routing rather than at the point it was named.
  const result = modelSchema.safeParse({
    id: "a-model-pool",
    strategy: "score",
    isAlias: false,
    targets: [
      {
        provider: "custom",
        model: "a-model",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 1, output: 2 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
  expect(result.success).toBe(false);
});
