import { expect, test } from "bun:test";
import { PROVIDER_IDS } from "@omni/providers/descriptors";
import { PROVIDER_IDS as CONNECT_PROVIDER_IDS } from "../src/connect.ts";
import { OAUTH_PROVIDER_IDS } from "../src/oauth/index.ts";
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
  // The reverse does not hold and must not be asserted: `custom` has no
  // authorization to start, and a provider may legitimately be key-only.
  for (const id of OAUTH_PROVIDER_IDS) {
    expect(PROVIDER_IDS).toContain(id);
  }
});

/**
 * `targetSchema` is a discriminated union: one arm covers the providers whose
 * targets need nothing but a model, the other covers `custom`, which also
 * requires an `endpointId` because that is the field an account is matched on.
 *
 * The arms are written out by hand and deliberately not derived — deriving the
 * first from the registry would widen its inferred `provider` type from the
 * literals back to `ProviderId`, and the union's exhaustiveness is the reason it
 * is a union at all. This test is what stands in for derivation: a seventh
 * provider that nobody added to an arm fails here rather than being silently
 * unsaveable.
 */
test("every provider can be saved as a target through some arm of the union", () => {
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
