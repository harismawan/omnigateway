import { expect, test } from "bun:test";
import { PROVIDER_MODEL_CATALOG } from "@omni/providers/catalog";
import { PROVIDER_DESCRIPTORS, PROVIDER_IDS } from "@omni/providers/descriptors";
import { providerCatalog } from "../src/catalog.ts";

/**
 * The failure this file exists for is a field dropped between the registry and
 * the response. It typechecks, it serialises, and it renders as an empty picker
 * or a missing price — so the assertions compare against the registry rather
 * than against a fixture of the response, which would agree with any assembly.
 */
test("every provider the registry describes is served", () => {
  expect(
    providerCatalog()
      .map((p) => p.id)
      .sort(),
  ).toEqual([...PROVIDER_IDS].sort());
});

test("every field the console reads survives assembly", () => {
  for (const provider of providerCatalog()) {
    const descriptor = PROVIDER_DESCRIPTORS[provider.id as keyof typeof PROVIDER_DESCRIPTORS];
    const catalog = PROVIDER_MODEL_CATALOG[provider.id as keyof typeof PROVIDER_MODEL_CATALOG];

    expect(provider.label).toBe(descriptor.presentation.label);
    expect(provider.order).toBe(descriptor.presentation.order);
    expect(provider.colour).toEqual(descriptor.presentation.colour);
    expect(provider.pasteHint).toBe(descriptor.presentation.pasteHint);
    expect(provider.callback).toEqual(descriptor.callback);
    expect(provider.defaultModel).toBe(catalog.defaultModel);
    expect(provider.authTypes).toEqual(catalog.authTypes);
    expect(provider.models).toEqual(catalog.models);
  }
});

test("a model carries the pricing and limits the editor seeds a target from", () => {
  // Named rather than covered by the deep-equal above, because these are the
  // fields the model editor writes into a saved target. A target created from a
  // response missing them is priced at zero for the rest of its life.
  const anthropic = providerCatalog().find((p) => p.id === "anthropic");
  const model = anthropic?.models[0];

  expect(model).toBeDefined();
  expect(Object.keys(model?.pricing ?? {}).sort()).toEqual([
    "cacheRead",
    "cacheWrite1h",
    "cacheWrite5m",
    "input",
    "output",
  ]);
  expect(typeof model?.limits.contextWindow).toBe("number");
  expect(typeof model?.limits.maxOutputTokens).toBe("number");
});

test("router internals are not shipped to the browser", () => {
  // `capabilities` and `writeOverInput` decide routing and pricing fallbacks. A
  // browser that could read them would eventually have something depend on them.
  // `tone` is a terminal colour name the CLI maps to an escape code.
  for (const provider of providerCatalog()) {
    expect(provider).not.toHaveProperty("capabilities");
    expect(provider).not.toHaveProperty("writeOverInput");
    expect(provider).not.toHaveProperty("tone");
    expect(provider).not.toHaveProperty("presentation");
  }
});

test("an absent optional field is absent, not present and undefined", () => {
  // `exactOptionalPropertyTypes` is on, and JSON.stringify drops an undefined
  // value entirely — so a payload built with `pasteHint: undefined` would differ from
  // one built without the key only after serialisation. Asserted on the object
  // so the difference cannot hide until it reaches a browser.
  // `callback` is the exercisable instance: four providers omit it, so writing
  // `callback: descriptor.callback` instead of the conditional spread fails this
  // and the round-trip check below. `pasteHint` shares the code shape exactly but
  // every provider currently states one, which makes the same mutation there
  // *equivalent* rather than uncaught — the first provider without a hint, most
  // likely a plugin, is what would exercise it.
  const custom = providerCatalog().find((p) => p.id === "custom");
  expect(custom).toBeDefined();
  expect(Object.hasOwn(custom ?? {}, "callback")).toBe(false);
});

test("the payload survives a JSON round trip unchanged", () => {
  // It is served as JSON. A value that does not survive that — a Set, a Map, a
  // RegExp arriving from some future descriptor field — serialises to `{}` with
  // nothing thrown anywhere, and the console renders a blank.
  //
  // `toStrictEqual`, not `toEqual`: the latter treats `{ pasteHint: undefined }`
  // and `{}` as equal, which is the one difference this assertion most needs to
  // see, since only one of them survives serialisation.
  const built = providerCatalog();
  expect(JSON.parse(JSON.stringify(built))).toStrictEqual(built);
});
