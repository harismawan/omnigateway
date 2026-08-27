import { expect, test } from "bun:test";
import type { ProviderId } from "@omni/ir";
import { catalogModelAuths, PROVIDER_MODEL_CATALOG } from "@omni/providers/catalog";
import { PROVIDER_DESCRIPTORS, PROVIDER_IDS } from "@omni/providers/descriptors";
import { entryOf } from "@omni/testkit";
import {
  type CatalogProblem,
  isPaletteSafeColour,
  isPaletteSafeProviderId,
  NEUTRAL_COLOUR,
  providerCatalog,
} from "../src/catalog.ts";

/**
 * The reporter every assembly below is handed.
 *
 * Fails the test that used it rather than collecting quietly: none of the
 * shipped providers has a problem, so a call to this is a regression in the
 * registry, and it should read as one at the assertion that caused it rather
 * than as a colour that came out grey three files away.
 */
function unexpected(problem: CatalogProblem): void {
  throw new Error(`unexpected catalog problem: ${problem.provider} ${problem.field}`);
}

/**
 * The failure this file exists for is a field dropped between the registry and
 * the response. It typechecks, it serialises, and it renders as an empty picker
 * or a missing price — so the assertions compare against the registry rather
 * than against a fixture of the response, which would agree with any assembly.
 */
test("every provider the registry describes is served", () => {
  expect(
    providerCatalog(unexpected)
      .map((p) => p.id)
      .sort(),
  ).toEqual([...PROVIDER_IDS].sort());
});

test("every field the console reads survives assembly", () => {
  for (const provider of providerCatalog(unexpected)) {
    const descriptor = entryOf(PROVIDER_DESCRIPTORS, provider.id, "PROVIDER_DESCRIPTORS");
    const catalog = entryOf(PROVIDER_MODEL_CATALOG, provider.id, "PROVIDER_MODEL_CATALOG");

    expect(provider.label).toBe(descriptor.presentation.label);
    expect(provider.order).toBe(descriptor.presentation.order);
    expect(provider.colour).toEqual(descriptor.presentation.colour);
    expect(provider.pasteHint).toBe(descriptor.presentation.pasteHint);
    expect(provider.callback).toEqual(descriptor.callback);
    expect(provider.defaultModel).toBe(catalog.defaultModel);
    expect(provider.authTypes).toEqual(catalog.authTypes);
    // Not a deep-equal against the catalog: the endpoint resolves each model's
    // `auth` and lists fields rather than spreading them, so the two differ on
    // purpose. The shape is pinned by its own test below.
    expect(provider.models.map((m) => m.id)).toEqual(catalog.models.map((m) => m.id));
  }
});

test("a model carries the pricing and limits the editor seeds a target from", () => {
  // Named rather than covered by the deep-equal above, because these are the
  // fields the model editor writes into a saved target. A target created from a
  // response missing them is priced at zero for the rest of its life.
  const anthropic = providerCatalog(unexpected).find((p) => p.id === "anthropic");
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

test("each model's auth arrives resolved, matching the catalog's own rule", () => {
  // The console used to hold a second copy of this expression. The endpoint now
  // answers it, so this asserts the answer is the same one `catalogModelAuths`
  // gives — the single place that rule is allowed to live.
  for (const provider of providerCatalog(unexpected)) {
    for (const model of provider.models) {
      expect(model.auth).toEqual(catalogModelAuths(provider.id as ProviderId, model.id));
      expect(model.auth).toBeDefined();
    }
  }
});

test("a model carries exactly the fields the console reads, and no others", () => {
  // The guard against a spread. `ProviderModelChoice` gains a field, and without
  // this it reaches every browser that loads the console with nothing failing —
  // which is how `reasoningForm` shipped before this test existed.
  const optional = new Set(["oauthLimits"]);
  for (const provider of providerCatalog(unexpected)) {
    for (const model of provider.models) {
      const keys = Object.keys(model)
        .filter((k) => !optional.has(k))
        .sort();
      expect(keys).toEqual(["auth", "id", "label", "limits", "pricing"]);
    }
  }
});

test("a provider registered after module load is served", () => {
  // The claim this endpoint is justified by: a provider that comes into
  // existence at boot — which is every plugin-supplied one — appears without
  // further change here.
  //
  // It was false. `PROVIDER_IDS` is `Object.keys(...)` evaluated at import, so
  // iterating it served a build-time snapshot: a descriptor added afterwards was
  // registered, ignored, and not reported. Mutating the registry is exactly what
  // the plugin host will do, so this test does it.
  const registry = PROVIDER_DESCRIPTORS as unknown as Record<string, unknown>;
  const seed = entryOf(PROVIDER_DESCRIPTORS, "anthropic", "PROVIDER_DESCRIPTORS");
  registry["runtime-registered"] = {
    ...seed,
    id: "runtime-registered",
    presentation: { ...seed.presentation, label: "Acme", order: 99 },
  };

  try {
    const served = providerCatalog(() => {});
    const registered = served.find((p) => p.id === "runtime-registered");
    expect(registered).toBeDefined();
    expect(registered?.label).toBe("Acme");
    // And it is a whole entry, not a stub: the picker needs its models.
    expect(registered?.models.length).toBeGreaterThan(0);
    expect(registered?.colour.light.length).toBeGreaterThan(0);
  } finally {
    delete registry["runtime-registered"];
  }
  expect(providerCatalog(() => {}).find((p) => p.id === "runtime-registered")).toBeUndefined();
});

test("a colour that would destroy the stylesheet is refused", () => {
  // Every one of these was ACCEPTED by the first validator and measured through
  // the real stylis pipeline: the first two emptied the whole ProviderPalette
  // sheet (0 of 12 declarations survived, both themes colourless), the NUL
  // closed the block early and spilled the rest to top level, and the truncated
  // call — a plain typo, no adversary — absorbed the template's own `}` and
  // `.dark {` into a custom-property value.
  const NUL = String.fromCharCode(0);
  for (const hostile of [
    "oklch(0.53 0.17 330) /*",
    'oklch(0.53 0.17 330) "',
    `oklch(0.53 0.17 330)${NUL}x`,
    NUL,
    "oklch(0.53 0.17 330",
    "x */ red",
    "red; } body { display: none; ",
    "red)",
  ]) {
    expect(isPaletteSafeColour(hostile)).toBe(false);
  }
});

test("a colour that fetches is refused even though its characters are legal", () => {
  // Inert today — every consumer puts `--p-<id>` in `color`, `border-left` or
  // `color-mix`, none of which fetch — but a future `background: var(--p-x)`
  // would make one an outbound request from a value a plugin supplied.
  for (const fetching of ["url(https://evil/x)", "image-set(url(x))", "attr(data-x)"]) {
    expect(isPaletteSafeColour(fetching)).toBe(false);
  }
});

test("every colour form the platform actually uses still passes", () => {
  // The risk an allowlist carries, and the reason the first version was a
  // denylist: a rule that rejects a working value is the one that hurts.
  for (const real of [
    "oklch(0.52 0.14 224)",
    "#aabbcc",
    "#aabbccdd",
    "rgb(1 2 3 / 50%)",
    "hsl(210 50% 40%)",
    "color-mix(in oklch, red 50%, blue)",
    "var(--p-anthropic)",
    "rebeccapurple",
    "transparent",
  ]) {
    expect(isPaletteSafeColour(real)).toBe(true);
  }
});

test("an empty or blank colour is refused", () => {
  // `--p-<id>:` with nothing after it is a parse error that takes the rest of
  // the block with it in some engines. The rule existed and was asserted
  // nowhere, so deleting either the trim or the length check survived the suite.
  expect(isPaletteSafeColour("")).toBe(false);
  expect(isPaletteSafeColour("   ")).toBe(false);
  expect(isPaletteSafeColour(" \t ")).toBe(false);
  // And a value that is only meaningful after trimming is served trimmed.
  expect(isPaletteSafeColour("  red  ")).toBe(true);
});

test("a provider whose id cannot be a custom property is withheld", () => {
  // The call site, not the predicate. `isPaletteSafeProviderId` was tested
  // directly while the branch using it survived being replaced by `if (false)`
  // — the id keys `--p-<id>`, the picker and the palette, so serving one that
  // cannot be a property name is worse than serving nothing.
  const registry = PROVIDER_DESCRIPTORS as unknown as Record<string, unknown>;
  const seed = entryOf(PROVIDER_DESCRIPTORS, "anthropic", "PROVIDER_DESCRIPTORS");
  registry["Bad Id{}"] = { ...seed, id: "Bad Id{}" };

  try {
    const problems: string[] = [];
    const served = providerCatalog((p) => problems.push(`${p.provider} ${p.field}`));
    expect(served.some((p) => p.id === "Bad Id{}")).toBe(false);
    expect(problems).toContain("Bad Id{} id");
  } finally {
    delete registry["Bad Id{}"];
  }
});

test("router internals are not shipped to the browser", () => {
  // `capabilities` and `writeOverInput` decide routing and pricing fallbacks. A
  // browser that could read them would eventually have something depend on them.
  // `tone` is a terminal colour name the CLI maps to an escape code.
  for (const provider of providerCatalog(unexpected)) {
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
  const custom = providerCatalog(unexpected).find((p) => p.id === "custom");
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
  const built = providerCatalog(unexpected);
  expect(JSON.parse(JSON.stringify(built))).toStrictEqual(built);
});

/* ------------------------------------------------------------- the palette -- */

/**
 * A writable view of one descriptor's presentation block.
 *
 * The registry's own types are `readonly`, correctly: nothing in the gateway
 * edits them. A provider that arrives from `<root>/plugins/` carries no such
 * guarantee — its presentation block is data that was read off disk — and
 * writing here is the only way to put a value of that shape in front of the
 * assembly today. Every caller restores what it found in a `finally`.
 */
function writableAnthropic(): { colour: { light: string; dark: string } } {
  return entryOf(PROVIDER_DESCRIPTORS, "anthropic", "PROVIDER_DESCRIPTORS").presentation as {
    colour: { light: string; dark: string };
  };
}

/**
 * The console writes every hue into a `createGlobalStyle` template by
 * concatenation, so a colour is a fragment of a stylesheet and this endpoint is
 * the last thing that looks at it. These tests are in that order deliberately:
 * the first says the rule admits everything the gateway ships, and the second
 * says it refuses the one shape that turns a hue into a rule of its own. A rule
 * with only the second test passes while rejecting every real colour.
 */
test("every colour the gateway ships passes the palette rule", () => {
  for (const provider of providerCatalog(unexpected)) {
    expect(isPaletteSafeProviderId(provider.id)).toBe(true);
    expect(isPaletteSafeColour(provider.colour.light)).toBe(true);
    expect(isPaletteSafeColour(provider.colour.dark)).toBe(true);
    // Not the neutral: a provider served grey is one whose real hue was
    // rejected, and an assembly that quietly greyed all six would satisfy the
    // three assertions above.
    expect(provider.colour.light).not.toBe(NEUTRAL_COLOUR);
    expect(provider.colour.dark).not.toBe(NEUTRAL_COLOUR);
  }
});

test("a value that would close the declaration is not a colour", () => {
  // The exact payload the review demonstrated escaping the block, plus each
  // character that makes it work, so deleting one from the class fails here
  // rather than in a browser.
  expect(isPaletteSafeColour("red; } body { display: none; ")).toBe(false);
  for (const hostile of ["a;b", "a{b", "a}b", "a<b", "a>b", "a\\b", "a\nb", "a\rb"]) {
    expect(isPaletteSafeColour(hostile)).toBe(false);
  }
  // Everything a colour actually needs, including the two syntaxes this
  // console uses and the ones a browser might gain next.
  for (const fine of [
    "oklch(0.56 0.13 45)",
    "#ff8800",
    "rgb(1 2 3 / 0.5)",
    "color-mix(in oklch, red 40%, blue)",
    "var(--ink-faint)",
  ]) {
    expect(isPaletteSafeColour(fine)).toBe(true);
  }
});

test("a hostile colour never leaves the gateway, so it cannot reach the stylesheet", () => {
  // Written against the registry the endpoint actually reads, not against the
  // predicate: the predicate being right and the assembly not calling it is the
  // failure this has to see. A plugin-supplied descriptor is the future path to
  // the same place, and it lands in this object the same way.
  const presentation = writableAnthropic();
  const original = presentation.colour;
  const problems: CatalogProblem[] = [];
  try {
    presentation.colour = { light: "red; } body { display: none; ", dark: original.dark };
    const anthropic = providerCatalog((problem) => problems.push(problem)).find(
      (p) => p.id === "anthropic",
    );

    expect(anthropic?.colour.light).toBe(NEUTRAL_COLOUR);
    // The other half is untouched: one bad value must not cost a provider the
    // mode it got right.
    expect(anthropic?.colour.dark).toBe(original.dark);
    // Reported, because a hue silently replaced by grey looks exactly like a
    // hue somebody chose grey.
    expect(problems).toEqual([
      {
        provider: "anthropic",
        field: "colour.light",
        reason: "not a CSS colour; served neutral grey instead",
      },
    ]);
  } finally {
    presentation.colour = original;
  }
});

test("a half-written colour is served whole", () => {
  // `{ light: "…" }` with no dark half: the shape a plugin author who tested in
  // one mode writes. Before this, it reached the console as the string
  // "undefined", which the CSS parser drops silently — the provider simply had
  // no colour in dark mode and nothing anywhere said so.
  const presentation = writableAnthropic();
  const original = presentation.colour;
  const problems: CatalogProblem[] = [];
  try {
    presentation.colour = { light: original.light } as { light: string; dark: string };
    const anthropic = providerCatalog((problem) => problems.push(problem)).find(
      (p) => p.id === "anthropic",
    );

    expect(anthropic?.colour.dark).toBe(NEUTRAL_COLOUR);
    expect(anthropic?.colour.light).toBe(original.light);
    expect(problems.map((p) => p.field)).toEqual(["colour.dark"]);
  } finally {
    presentation.colour = original;
  }
});

test("an id that cannot name a custom property is not served", () => {
  // The palette builds `--p-<id>`, so the id is interpolated into a stylesheet
  // exactly as the colour is. It cannot be exercised through the registry —
  // `PROVIDER_IDS` is read from the descriptor keys at module load — so the rule
  // is asserted where a plugin manifest will meet it.
  for (const id of ["anthropic", "openai", "kimi", "kilo", "grok", "custom", "some-plugin"]) {
    expect(isPaletteSafeProviderId(id)).toBe(true);
  }
  for (const id of ["", "Anthropic", "1up", "a;b", "a}b", "a b", "a_b", `a${"b".repeat(40)}`]) {
    expect(isPaletteSafeProviderId(id)).toBe(false);
  }
});
