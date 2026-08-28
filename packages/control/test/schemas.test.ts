import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "@omni/store";
import { isProviderId } from "../src/connect.ts";
import { keyCreateSchema, modelSchema, providerIdSchema, settingsSchema } from "../src/schemas.ts";

const target = (provider: string): Record<string, unknown> => ({
  provider,
  model: "anthropic/claude-sonnet-5",
  tier: 1,
  weight: 1,
  costPerMTok: { input: 2, output: 10 },
  capabilities: { tools: true, images: true, reasoning: true },
});

const model = (provider: string) => ({
  id: "fast",
  strategy: "score" as const,
  isAlias: false,
  targets: [target(provider)],
});

/**
 * The three provider lists that TypeScript cannot check against `ProviderId`.
 *
 * `providerIdSchema` gates credential creation and the target union gates model
 * configuration, so a provider present in one and missing from the other
 * produces a build that connects an account it can never route to.
 */
test("a kilo credential can be created and a kilo target can be configured", () => {
  expect(providerIdSchema.parse("kilo")).toBe("kilo");
  expect(modelSchema.parse(model("kilo")).targets[0]?.provider).toBe("kilo");
  expect(isProviderId("kilo")).toBe(true);
});

test("every provider id can back a target, including one no build knows about", () => {
  // `targetSchema` used to restrict this to a hand-written five-member enum, on
  // the argument that the narrowing was the last compile-time check a new
  // provider had been thought about. That argument died with the closed
  // `ProviderId`, and the enum outlived it — refusing every target naming a
  // provider supplied by a plugin, which is to say every provider this whole
  // effort exists to make possible.
  for (const id of ["anthropic", "openai", "kimi", "kilo", "grok"]) {
    expect(modelSchema.parse(model(id)).targets[0]?.provider).toBe(id);
  }

  // The one that matters: an id no build contains, arriving from a plugin.
  expect(modelSchema.parse(model("acme-ai")).targets[0]?.provider).toBe("acme-ai");
});

test("a custom target still requires its endpoint, and only custom may carry one", () => {
  // What the discriminated union actually enforced, kept as the rule it always
  // was. A custom target with no endpoint matches no account, so it would save
  // clean and fail every request at routing rather than at the point it was
  // named.
  expect(() => modelSchema.parse(model("custom"))).toThrow(/endpointId/);

  const withEndpoint = model("custom");
  withEndpoint.targets[0] = { ...withEndpoint.targets[0], endpointId: "local-vllm" };
  expect(modelSchema.parse(withEndpoint).targets[0]).toMatchObject({
    provider: "custom",
    endpointId: "local-vllm",
  });

  // And the other direction, which the union got for free from `.strict()` and
  // this gets from a named rule.
  const builtIn = model("anthropic");
  builtIn.targets[0] = { ...builtIn.targets[0], endpointId: "not-allowed" };
  expect(() => modelSchema.parse(builtIn)).toThrow(/only meaningful for a custom target/);
});

test("a provider that does not exist is refused where it can be", () => {
  // Three questions that used to have one answer, and now have two.
  //
  // `providerIdSchema` checks format alone: it was an enum over a module-scope
  // key list, which is a snapshot taken before any plugin provider is
  // registered, so keeping it would refuse exactly the ids this work exists to
  // allow. `isProviderId` is the existence check, read from the registry at call
  // time, and `createApiKeyCredential` is what calls it.
  //
  // `targetSchema` no longer refuses an unknown provider at all, and that is
  // deliberate: it is the same exemption a dangling pin already had, because
  // removing a provider must not make an unrelated model unsavable. `omni
  // doctor` and the router's `provider:missing` carry that weight instead.
  expect(providerIdSchema.parse("kilocode")).toBe("kilocode");
  expect(isProviderId("kilocode")).toBe(false);
  expect(modelSchema.parse(model("kilocode")).targets[0]?.provider).toBe("kilocode");
});

test("providerIdSchema still refuses an id that cannot name a provider", () => {
  // Restored after the schema stopped being an enum. Without it, this file
  // asserted only that ids *parse*, so loosening the pattern to `/^.+$/` — which
  // makes format and existence the same question — passed the whole suite.
  //
  // Format is a real gate: the id becomes a `--p-<id>` custom property, a
  // `plugin_<id>_*` table prefix and a `plugin:<id>:*` topic, so an id that
  // cannot be all three has to fail here rather than wherever notices first.
  for (const bad of ["", "Anthropic", "1kilo", "kilo_code", "kilo.code", "-kilo", "a".repeat(33)]) {
    expect(providerIdSchema.safeParse(bad).success).toBe(false);
  }
  // The positive control: a pattern refusing everything would satisfy the loop.
  expect(providerIdSchema.safeParse("well-formed-plugin-id").success).toBe(true);
});

/**
 * The settings schema and the `Settings` type are two descriptions of one shape,
 * and only the type is checked by the compiler. A field on the type but absent
 * from the schema is dropped on the way through `PUT /api/settings`, which reads
 * as an operator's toggle refusing to stick.
 */
test("every settings field survives a round trip through the schema", () => {
  expect(settingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);

  const on = {
    ...DEFAULT_SETTINGS,
    bodyLoggingEnabled: true,
    bodyLoggingCaptureStreamChunks: true,
  };
  expect(settingsSchema.parse(on)).toEqual(on);
});

test("the body logging settings are booleans, not anything truthy", () => {
  expect(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, bodyLoggingEnabled: "true" })).toThrow();
  expect(() =>
    settingsSchema.parse({ ...DEFAULT_SETTINGS, bodyLoggingCaptureStreamChunks: 1 }),
  ).toThrow();
});

/**
 * Both halves are required: a settings object missing either boolean cannot be
 * saved, because a partial write would silently reset the field it omitted.
 */
test("settings cannot be saved with a body logging field missing", () => {
  const { bodyLoggingEnabled: _enabled, ...withoutEnabled } = DEFAULT_SETTINGS;
  const { bodyLoggingCaptureStreamChunks: _chunks, ...withoutChunks } = DEFAULT_SETTINGS;
  expect(() => settingsSchema.parse(withoutEnabled)).toThrow();
  expect(() => settingsSchema.parse(withoutChunks)).toThrow();
});

/**
 * The opt-out defaults off rather than being required, because the setting it
 * defers to is itself off by default: a key that says nothing inherits the
 * installation's policy rather than opting out of one it has not met.
 */
test("a key opts out of body capture only when it asks to", () => {
  expect(keyCreateSchema.parse({}).bodyLoggingOptOut).toBe(false);
  expect(keyCreateSchema.parse({ bodyLoggingOptOut: true }).bodyLoggingOptOut).toBe(true);
  expect(() => keyCreateSchema.parse({ bodyLoggingOptOut: "yes" })).toThrow();
});
