import { expect, test } from "bun:test";
import { ADAPTERS } from "@omni/providers";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import { entryOf } from "@omni/testkit";
import { readProviders, validateRegistration } from "../src/pluginProviders.ts";

/**
 * What a plugin hands the host, and what the host refuses to take its word for.
 *
 * `PluginProvider` types both halves as `unknown`, since
 * `@omnigateway/plugin-api` is published and cannot import `@omni/ir` until a
 * later sub-project. That looseness is deliberate and it is paid for here: every
 * one of these cases would have typechecked on the plugin's side.
 */

const anthropic = entryOf(PROVIDER_DESCRIPTORS, "anthropic", "PROVIDER_DESCRIPTORS");

function descriptor(over: Record<string, unknown> = {}) {
  return { ...anthropic, id: "acme-ai", ...over };
}

const codec = {
  buildRequest: () => ({ request: { url: "https://x", method: "POST", headers: [], body: "{}" } }),
  decode: async function* () {},
};

test("a well-formed registration becomes an adapter under the plugin's own id", () => {
  const registered = validateRegistration("acme-ai", { descriptor: descriptor(), codec });

  expect(registered.descriptor.id).toBe("acme-ai");
  expect(registered.adapter.id).toBe("acme-ai");
  // The adapter reports the descriptor's capabilities, because routing filters
  // on them before dispatch ever runs.
  expect(registered.adapter.capabilities).toEqual(anthropic.capabilities);
});

test("a plugin cannot register a provider under another plugin's id", () => {
  // The rule that keeps `plugin:<id>:` topics and `plugin_<id>_` tables inside
  // their owner, applied to the registry. A plugin shadowing `anthropic` would
  // take its traffic and its stored credentials.
  expect(() =>
    validateRegistration("acme-ai", { descriptor: descriptor({ id: "anthropic" }), codec }),
  ).toThrow(/may only register its own id/);

  // Both ids are named, because "id mismatch" sends a reader to look at one.
  try {
    validateRegistration("acme-ai", { descriptor: descriptor({ id: "anthropic" }), codec });
  } catch (error) {
    expect((error as Error).message).toContain("acme-ai");
    expect((error as Error).message).toContain("anthropic");
  }
});

test("an id that cannot name a provider is refused before anything else is read", () => {
  // The id becomes a `--p-<id>` custom property, a table prefix and a topic, so
  // it is checked against the one grammar rather than trusted.
  for (const id of ["Acme AI", "1acme", "acme_ai", "", "a".repeat(33)]) {
    expect(() => validateRegistration(id, { descriptor: descriptor({ id }), codec })).toThrow(
      /not a usable provider id/,
    );
  }
});

test("a descriptor missing a required field is refused, naming the field", () => {
  // Required with no defaults, exactly as a built-in is. `writeOverInput`
  // defaulting to zero underprices cache writes silently and permanently, which
  // is the failure the whole descriptor shape exists to prevent.
  for (const field of [
    "capabilities",
    "writeOverInput",
    "catalog",
    "modelPrefixes",
    "presentation",
  ]) {
    const incomplete = descriptor();
    delete (incomplete as Record<string, unknown>)[field];
    expect(() => validateRegistration("acme-ai", { descriptor: incomplete, codec })).toThrow(
      new RegExp(`missing ${field}`),
    );
  }
});

test("a codec missing a function is refused, and a non-callable hook too", () => {
  expect(() => validateRegistration("acme-ai", { descriptor: descriptor(), codec: {} })).toThrow(
    /no buildRequest/,
  );
  expect(() =>
    validateRegistration("acme-ai", {
      descriptor: descriptor(),
      codec: { buildRequest: codec.buildRequest },
    }),
  ).toThrow(/no decode/);
  expect(() =>
    validateRegistration("acme-ai", {
      descriptor: descriptor(),
      codec: { ...codec, classifyError: "not a function" },
    }),
  ).toThrow(/non-callable classifyError/);
});

test("nothing that is not an object is accepted for either half", () => {
  for (const bad of [null, undefined, "descriptor", 42, []]) {
    expect(() => validateRegistration("acme-ai", { descriptor: bad, codec })).toThrow();
  }
  for (const bad of [null, undefined, "codec", 42]) {
    expect(() =>
      validateRegistration("acme-ai", { descriptor: descriptor(), codec: bad }),
    ).toThrow();
  }
});

/**
 * What `readProviders` refuses, and what it lets through untouched.
 *
 * This replaced a `ctx.provider.register(…)` capability collected during
 * `setup`. The move is the whole point of the field: a descriptor that exists
 * only after arbitrary plugin code has run can be read by the gateway and by
 * nothing else, and the CLI needs the same answer without running `setup` — it
 * would open channels, apply migrations and register routes, which is a
 * diagnostic with side effects.
 */
const declaring = (over: Record<string, unknown> = {}) => ({
  providers: [{ descriptor: descriptor(), codec }],
  ...over,
});
const withCapability = { capabilities: ["provider"] as readonly string[] };

test("a declared provider becomes an adapter, and no plugin code runs to get it", () => {
  let ran = false;
  const definition = {
    ...declaring(),
    setup: () => {
      ran = true;
      return undefined;
    },
  };

  const read = readProviders("acme-ai", withCapability, definition);

  expect(read).toHaveLength(1);
  expect(read[0]?.descriptor.id).toBe("acme-ai");
  expect(read[0]?.adapter.id).toBe("acme-ai");
  // The property the field exists for: `setup` is untouched. A capability could
  // not have been read this way at all.
  expect(ran).toBe(false);
});

test("a plugin declaring no provider is not an error", () => {
  // The ordinary case — most plugins supply none — and it must not require the
  // capability either, or every UI-only plugin would fail to load.
  expect(readProviders("acme-ai", { capabilities: [] }, { setup: () => undefined })).toEqual([]);
  expect(
    readProviders("acme-ai", withCapability, { providers: [], setup: () => undefined }),
  ).toEqual([]);
});

test("a provider declared without the manifest capability is refused", () => {
  // The capability is what keeps a plugin's reach auditable without reading its
  // code. Losing that check would not break anything visibly — the provider
  // would simply work — which is why it is asserted rather than assumed.
  expect(() =>
    readProviders(
      "acme-ai",
      { capabilities: ["storage"] },
      { ...declaring(), setup: () => undefined },
    ),
  ).toThrow(/"provider" capability/);
});

test("a plugin declaring two providers is refused rather than silently keeping one", () => {
  // `descriptor.id` must equal the plugin's own id, so two entries cannot both
  // be valid. The field is an array so that rule can change without the
  // published shape changing; until it does, the second would silently win.
  const two = {
    providers: [
      { descriptor: descriptor(), codec },
      { descriptor: descriptor(), codec },
    ],
    setup: () => undefined,
  };
  expect(() => readProviders("acme-ai", withCapability, two)).toThrow(/more than one provider/);
});

test("reading a declaration writes nothing global", () => {
  // The reason the loader returns providers rather than installing them:
  // `readProviders` runs before `setup`, and `setup` can still throw. A provider
  // written into the live tables by a plugin the host went on to reject would be
  // admitted by routing and then fail every request with INTERNAL, while the
  // operator was told the plugin was unavailable.
  //
  // Asserted at this boundary because it is a property of this function — it
  // returns a value and touches no table. `loader.test.ts` covers the other half,
  // that the loader's `continue` drops what it returned.
  const read = readProviders("acme-ai", withCapability, { ...declaring(), setup: () => undefined });

  expect(read).toHaveLength(1);
  expect(Object.hasOwn(PROVIDER_DESCRIPTORS, "acme-ai")).toBe(false);
  expect(Object.hasOwn(ADAPTERS, "acme-ai")).toBe(false);
});

/**
 * The registrations that used to be admitted and then crashed the router.
 *
 * These are the exact values a review drove through `resolveModel`: each passed
 * the old `!== undefined` check, and `entryPricing`'s `entry.models.find` then
 * threw a raw `TypeError`. `classify` reads that as `INTERNAL`,
 * `RETRYABLE.INTERNAL` is false, and the message reaches the client body — the
 * same shape as the `constructor/foo` bug, through a different table.
 *
 * The twin was `/api/catalog`, where `catalog.models.map` on the same value is a
 * 500, and a 500 there is what the console's all-or-nothing shell gate turns
 * into "Console unavailable" on every screen. One check at the boundary rather
 * than a guard at each reader, for the reason the prototype sweep already
 * settled: partial protection that reads as total is worse than none.
 */
test("a catalog that is not a catalog is refused at registration", () => {
  const bad: ReadonlyArray<readonly [unknown, RegExp]> = [
    [42, /catalog must be an object/],
    ["a catalog, honest", /catalog must be an object/],
    // `null` is present-and-wrong, not absent — only `undefined` reads as
    // missing, which is the distinction the two messages exist to keep.
    [null, /catalog must be an object/],
    [undefined, /is missing catalog/],
    // An array is an object to `typeof` and to nothing else, so `isRecord`
    // refuses it explicitly rather than letting `catalog.models` be `undefined`.
    [[], /catalog must be an object/],
    [{}, /catalog\.defaultModel must be a string/],
    [{ defaultModel: "m", authTypes: ["apiKey"] }, /catalog\.models must be an array/],
    [
      { defaultModel: "m", authTypes: ["apiKey"], models: "no" },
      /catalog\.models must be an array/,
    ],
    [
      { defaultModel: "m", authTypes: ["apiKey"], models: null },
      /catalog\.models must be an array/,
    ],
    [{ defaultModel: "m", authTypes: "apiKey", models: [] }, /catalog\.authTypes must be an array/],
    [{ defaultModel: "m", authTypes: ["oauth2"], models: [] }, /catalog\.authTypes\[0\]/],
  ];
  for (const [catalog, message] of bad) {
    expect(() =>
      validateRegistration("acme-ai", { descriptor: descriptor({ catalog }), codec }),
    ).toThrow(message);
  }
});

test("a model entry the router would price is checked field by field", () => {
  const model = {
    id: "acme-1",
    label: "Acme 1",
    pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 1.2, cacheWrite1h: 2 },
    limits: { contextWindow: 100, maxOutputTokens: 10 },
  };
  const withModel = (over: Record<string, unknown>) => ({
    defaultModel: "acme-1",
    authTypes: ["apiKey"],
    models: [{ ...model, ...over }],
  });

  // Every field some consumer dereferences, and no more than those.
  const bad: ReadonlyArray<readonly [Record<string, unknown>, RegExp]> = [
    [{ id: 1 }, /catalog\.models\[0\]\.id must be a string/],
    [{ label: null }, /catalog\.models\[0\]\.label must be a string/],
    [{ pricing: undefined }, /catalog\.models\[0\]\.pricing must be an object/],
    [{ pricing: { ...model.pricing, input: "free" } }, /pricing\.input must be a finite number/],
    // `NaN` is the one that would not throw and would not be noticed: it
    // propagates through every sum into `costUsd` and renders as a blank.
    [{ pricing: { ...model.pricing, cacheWrite1h: Number.NaN } }, /pricing\.cacheWrite1h/],
    [{ pricing: { ...model.pricing, output: Number.POSITIVE_INFINITY } }, /pricing\.output/],
    [{ limits: { contextWindow: 100 } }, /limits\.maxOutputTokens must be a finite number/],
    [{ oauthLimits: { contextWindow: "wide" } }, /oauthLimits\.contextWindow/],
  ];
  for (const [over, message] of bad) {
    expect(() =>
      validateRegistration("acme-ai", {
        descriptor: descriptor({ catalog: withModel(over) }),
        codec,
      }),
    ).toThrow(message);
  }

  // The positive control, and the one case absence is a fact rather than a gap:
  // no `oauthLimits` means one set of limits covers both ways in.
  expect(() =>
    validateRegistration("acme-ai", { descriptor: descriptor({ catalog: withModel({}) }), codec }),
  ).not.toThrow();
});

test("the fields dispatch and the console dereference are checked too", () => {
  const bad: ReadonlyArray<readonly [Record<string, unknown>, RegExp]> = [
    // Read by `priceOf` inside `finishLog`, where a throw would break usage
    // accounting for a request that already succeeded.
    [{ writeOverInput: { fiveMinute: 1.25 } }, /writeOverInput\.oneHour must be a finite number/],
    [{ writeOverInput: 2 }, /writeOverInput must be an object/],
    [{ capabilities: { tools: true, images: true } }, /capabilities\.reasoning must be a boolean/],
    [{ capabilities: { tools: "yes", images: true, reasoning: true } }, /capabilities\.tools/],
    // Iterated by the router's prefix table.
    [{ modelPrefixes: "acme-" }, /modelPrefixes must be an array/],
    [{ modelPrefixes: ["acme-", 7] }, /modelPrefixes\[1\] must be a string/],
    // Destructured by `providerCatalog`, whose 500 blanks the whole console.
    [{ presentation: { ...anthropic.presentation, label: 1 } }, /presentation\.label/],
    [{ presentation: { ...anthropic.presentation, order: "first" } }, /presentation\.order/],
    [
      { presentation: { ...anthropic.presentation, colour: "red" } },
      /presentation\.colour must be an object/,
    ],
    [
      { presentation: { ...anthropic.presentation, colour: { light: "#fff" } } },
      /presentation\.colour\.dark must be a string/,
    ],
    [{ presentation: { ...anthropic.presentation, pasteHint: 3 } }, /presentation\.pasteHint/],
  ];
  for (const [over, message] of bad) {
    expect(() => validateRegistration("acme-ai", { descriptor: descriptor(over), codec })).toThrow(
      message,
    );
  }

  // A colour is checked for being a string and not for being *renderable*:
  // `isPaletteSafeColour` already substitutes a neutral, and refusing a whole
  // provider over an unrenderable colour is a worse trade than showing it grey.
  expect(() =>
    validateRegistration("acme-ai", {
      descriptor: descriptor({
        presentation: { ...anthropic.presentation, colour: { light: "url(evil)", dark: "x" } },
      }),
      codec,
    }),
  ).not.toThrow();
});
