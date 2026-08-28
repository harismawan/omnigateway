import { expect, test } from "bun:test";
import type { ProviderId } from "@omni/ir";
import { DEFAULT_SETTINGS } from "@omni/store";
import { isProviderId } from "../src/connect.ts";
import { keyCreateSchema, modelSchema, providerIdSchema, settingsSchema } from "../src/schemas.ts";

const target = (provider: string) => ({
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

test("every provider id but custom can back a plain target", () => {
  // The literal tuple, not `ProviderId[]`. `targetSchema`'s non-custom arm keeps
  // a hand-written five-member enum, so what it parses back is narrower than the
  // validated string a provider id is — and that narrowing is the point: it is
  // now the only compile-time check that a new provider was thought about at all.
  const ids = [
    "anthropic",
    "openai",
    "kimi",
    "kilo",
    "grok",
  ] as const satisfies readonly ProviderId[];
  for (const id of ids) {
    expect(providerIdSchema.parse(id)).toBe(id);
    expect(isProviderId(id)).toBe(true);
    expect(modelSchema.parse(model(id)).targets[0]?.provider).toBe(id);
  }

  // `custom` is its own arm of the union: it carries an endpoint id and would
  // be rejected by the shape above.
  expect(providerIdSchema.parse("custom")).toBe("custom");
  expect(() => modelSchema.parse(model("custom"))).toThrow();
});

test("a provider that does not exist is refused where it can be", () => {
  // Three questions that used to have one answer, and now have two.
  //
  // `providerIdSchema` checks format alone: it was an enum over a module-scope
  // key list, which is a snapshot taken before any plugin provider is
  // registered, so keeping it would refuse exactly the ids this work exists to
  // allow. `isProviderId` is the existence check, read from the registry at call
  // time, and `createApiKeyCredential` is what calls it. `targetSchema`'s
  // non-custom arm stays a hand-written enum by design — it is now the only
  // compile-time check that a new provider was thought about at all.
  expect(providerIdSchema.parse("kilocode")).toBe("kilocode");
  expect(isProviderId("kilocode")).toBe(false);
  expect(() => modelSchema.parse(model("kilocode"))).toThrow();
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
