import { describe, expect, test } from "bun:test";
import type { ProviderId } from "@omni/ir";
import { BODY_ORDER } from "../src/body.ts";
import { PROVIDER_MODEL_CATALOG } from "../src/catalog.ts";
import type { ProviderDescriptor } from "../src/descriptor.ts";
import { PROVIDER_DESCRIPTORS } from "../src/descriptors.ts";
import { PROFILES } from "../src/profile.ts";
import { ADAPTERS, PROVIDERS } from "../src/registry.ts";
import { entry } from "./entry.ts";

/**
 * The six ids, written out once here and nowhere else in this file.
 *
 * Deliberately a literal rather than `Object.keys(PROVIDER_DESCRIPTORS)`: this
 * is the test that would catch a descriptor going missing, and deriving the list
 * from the thing under test would make it agree with any registry at all.
 */
const IDS = [
  "anthropic",
  "openai",
  "kimi",
  "kilo",
  "grok",
  "antigravity",
  "muse",
  "custom",
] as const satisfies readonly ProviderId[];

/**
 * The six, as a type.
 *
 * Every `*_BEFORE` fixture below is keyed on this rather than on `ProviderId`,
 * which is a validated string now and would let a fixture drop a provider
 * without a word. Keying on the tuple restores each fixture's own totality:
 * delete a line from one and it stops compiling, which is the whole reason
 * these fixtures are literals.
 */
type BuiltIn = (typeof IDS)[number];

/**
 * A verbatim copy of `WRITE_OVER_INPUT` as it stood in
 * `apps/gateway/src/dispatch/price.ts` before the descriptors existed.
 *
 * Checked in as a literal on purpose. An equivalence test that read the live
 * table on both sides would pass against any value, including a wrong one —
 * which is the whole failure this fixture exists to prevent. When a provider's
 * real pricing changes, this fixture changes in the same commit and the diff
 * says so.
 */
const WRITE_OVER_INPUT_BEFORE: Readonly<Record<BuiltIn, { fiveMinute: number; oneHour: number }>> =
  {
    anthropic: { fiveMinute: 1.25, oneHour: 2 },
    openai: { fiveMinute: 0, oneHour: 0 },
    kimi: { fiveMinute: 0, oneHour: 0 },
    kilo: { fiveMinute: 0, oneHour: 0 },
    grok: { fiveMinute: 0, oneHour: 0 },
    // No "before" for antigravity — it postdates the table these fixtures
    // record. The line is here because each fixture is keyed on `BuiltIn` and so
    // must be total: a provider added without one stops this file compiling,
    // which is the property that keeps the literals honest.
    antigravity: { fiveMinute: 0, oneHour: 0 },
    muse: { fiveMinute: 0, oneHour: 0 },
    custom: { fiveMinute: 0, oneHour: 0 },
  };

/** Likewise for `PROVIDER_CAPABILITIES`, as it stood in `packages/ir`. */
const CAPABILITIES_BEFORE: Readonly<
  Record<BuiltIn, { tools: boolean; images: boolean; reasoning: boolean }>
> = {
  anthropic: { tools: true, images: true, reasoning: true },
  openai: { tools: true, images: true, reasoning: true },
  kimi: { tools: true, images: false, reasoning: false },
  kilo: { tools: true, images: true, reasoning: true },
  grok: { tools: true, images: true, reasoning: true },
  antigravity: { tools: true, images: true, reasoning: true },
  muse: { tools: true, images: true, reasoning: true },
  custom: { tools: true, images: true, reasoning: true },
};

describe("the registry describes every provider", () => {
  test("one descriptor per id, and no others", () => {
    expect(Object.keys(PROVIDER_DESCRIPTORS).sort()).toEqual([...IDS].sort());
    expect(Object.keys(PROVIDERS).sort()).toEqual([...IDS].sort());
  });

  test("no provider table answers for a key it does not hold", () => {
    // A provider id arrives from a client's `model` name and from unvalidated
    // JSON in `virtual_models.targets`. On an ordinary object literal,
    // `table["constructor"]` is the `Object` constructor, so every
    // `!== undefined` and `?.` guard reads "installed" and then throws on the
    // next property access — `model: "constructor/foo"` returned a 500 carrying
    // an internal source expression to the client.
    //
    // Asserting the *lookups* rather than `Object.getPrototypeOf(...) === null`
    // on purpose: the property under test is what a reader gets back, and a
    // future table built some other way (`Object.create(null)`, a `Map` wrapper,
    // a frozen proxy) should pass this by being correct rather than by matching
    // one implementation of correctness.
    const tables: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
      ["PROVIDER_DESCRIPTORS", PROVIDER_DESCRIPTORS],
      ["PROVIDER_MODEL_CATALOG", PROVIDER_MODEL_CATALOG],
      ["PROFILES", PROFILES],
      ["BODY_ORDER", BODY_ORDER],
      ["ADAPTERS", ADAPTERS],
      ["PROVIDERS", PROVIDERS],
    ];
    // `__proto__` is deliberately absent: on a null-prototype object it is an
    // ordinary missing key, but on a plain one it is an accessor rather than a
    // value, so it would fail here for a reason unrelated to the bug.
    const inherited = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"];

    for (const [name, table] of tables) {
      for (const key of inherited) {
        expect({ table: name, key, value: table[key] }).toEqual({
          table: name,
          key,
          value: undefined,
        });
      }
      // The positive control. A table that answered `undefined` for everything
      // would satisfy the loop above and nothing else in this test.
      expect(table.anthropic).toBeDefined();
    }
  });

  test("every descriptor is complete", () => {
    // Required with no defaults: a missing `writeOverInput` must be a loud
    // failure here rather than a zero that underprices cache writes for good.
    for (const id of IDS) {
      const descriptor = entry(PROVIDER_DESCRIPTORS, id, "PROVIDER_DESCRIPTORS");
      expect(descriptor.id).toBe(id);
      expect(descriptor.capabilities).toBeDefined();
      expect(typeof descriptor.writeOverInput.fiveMinute).toBe("number");
      expect(typeof descriptor.writeOverInput.oneHour).toBe("number");
      expect(descriptor.catalog).toBeDefined();
      expect(Array.isArray(descriptor.catalog.models)).toBe(true);
    }
  });

  test("a descriptor missing a required field does not satisfy the type", () => {
    // The negative case, without which the completeness test above passes
    // against a validator that does nothing. It is a compile-time guarantee, so
    // what is asserted is that the directive is *needed*: make `writeOverInput`
    // optional on `ProviderDescriptor` and TypeScript reports the
    // `@ts-expect-error` as unused, which fails the typecheck.
    //
    // Every other required field is present, and that is the whole design of
    // this fixture. Two earlier versions were satisfied by something other than
    // the field they named — first by `modelPrefixes` and `presentation` being
    // absent too, then by `PROVIDER_MODEL_CATALOG.anthropic` turning nullable
    // when the table's key widened to `string`. A negative control that passes
    // for an unrelated reason is indistinguishable from one that works, so this
    // one is deliberately complete except for the single field under test.
    const incomplete = {
      id: "anthropic",
      capabilities: { tools: true, images: true, reasoning: true },
      catalog: entry(PROVIDER_MODEL_CATALOG, "anthropic", "PROVIDER_MODEL_CATALOG"),
      modelPrefixes: ["claude-"],
      presentation: {
        label: "Anthropic",
        order: 1,
        tone: "magenta",
        colour: { light: "oklch(0.56 0.13 45)", dark: "oklch(0.74 0.12 48)" },
      },
    };
    // @ts-expect-error — `writeOverInput` is required and absent.
    const rejected: ProviderDescriptor = incomplete;
    expect(rejected).toBeDefined();
  });
});

describe("descriptors carry the values the old tables held", () => {
  test("capabilities match the pre-change fixture", () => {
    for (const id of IDS) {
      expect(entry(PROVIDER_DESCRIPTORS, id, "PROVIDER_DESCRIPTORS").capabilities).toEqual(
        CAPABILITIES_BEFORE[id],
      );
    }
  });

  test("writeOverInput matches the pre-change fixture", () => {
    for (const id of IDS) {
      expect(entry(PROVIDER_DESCRIPTORS, id, "PROVIDER_DESCRIPTORS").writeOverInput).toEqual(
        WRITE_OVER_INPUT_BEFORE[id],
      );
    }
  });

  test("the catalog entry is the same object the catalog subpath serves", () => {
    // Identity, not deep equality: the descriptor must reference the provider's
    // own models list rather than hold a copy of it, or the browser-safe catalog
    // and the registry become two sources that can disagree.
    for (const id of IDS) {
      expect(entry(PROVIDER_DESCRIPTORS, id, "PROVIDER_DESCRIPTORS").catalog).toBe(
        entry(PROVIDER_MODEL_CATALOG, id, "PROVIDER_MODEL_CATALOG"),
      );
    }
  });
});

describe("presentation and routing data match their pre-change fixtures", () => {
  /** `PREFIX_PROVIDER` as it stood in `packages/router/src/resolve.ts`. */
  const PREFIXES_BEFORE: Readonly<Record<BuiltIn, readonly string[]>> = {
    anthropic: ["claude-"],
    openai: ["gpt-", "o1", "o3", "o4"],
    kimi: ["kimi-", "moonshot"],
    kilo: [],
    grok: ["grok-"],
    antigravity: ["gemini-"],
    muse: ["muse-", "muse-spark"],
    custom: [],
  };

  /** `CALLBACKS` as it stood in `packages/control/src/connect.ts`. */
  const CALLBACKS_BEFORE: Readonly<Partial<Record<BuiltIn, { uri: string; label: string }>>> = {
    openai: { uri: "http://localhost:1455/auth/callback", label: "OpenAI" },
    grok: { uri: "http://127.0.0.1:56121/callback", label: "Grok" },
    // Not a loopback since 2026-09-05: Antigravity moved to the hosted callback
    // its own CLI uses, which works from a browser on any machine. The change is
    // paired with a code challenge — see `antigravity/oauth.ts`'s header.
    antigravity: { uri: "https://antigravity.google/oauth-callback", label: "Antigravity" },
  };

  /** `PROVIDER_LABEL`, which existed in three separate copies. */
  const LABELS_BEFORE: Readonly<Record<BuiltIn, string>> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    kimi: "Kimi",
    kilo: "Kilo",
    grok: "Grok",
    antigravity: "Antigravity",
    muse: "Muse",
    custom: "OpenAI Compatible",
  };

  /** `PROVIDER_TONE` as it stood in `apps/cli/src/command.ts`. */
  const TONES_BEFORE: Readonly<Record<BuiltIn, string>> = {
    anthropic: "magenta",
    openai: "green",
    kimi: "blue",
    kilo: "orange",
    grok: "yellow",
    antigravity: "violet",
    muse: "azure",
    custom: "cyan",
  };

  /** The `--p-<id>` custom properties, both themes, from `GlobalStyle.ts`. */
  const COLOURS_BEFORE: Readonly<Record<BuiltIn, { light: string; dark: string }>> = {
    anthropic: { light: "oklch(0.56 0.13 45)", dark: "oklch(0.74 0.12 48)" },
    openai: { light: "oklch(0.5 0.09 190)", dark: "oklch(0.76 0.1 190)" },
    kimi: { light: "oklch(0.53 0.17 330)", dark: "oklch(0.72 0.16 330)" },
    kilo: { light: "oklch(0.52 0.14 224)", dark: "oklch(0.74 0.14 224)" },
    grok: { light: "oklch(0.52 0.14 125)", dark: "oklch(0.74 0.14 125)" },
    antigravity: { light: "oklch(0.52 0.14 277)", dark: "oklch(0.74 0.14 277)" },
    muse: { light: "oklch(0.55 0.23 262)", dark: "oklch(0.72 0.17 262)" },
    custom: { light: "oklch(0.5 0.03 258)", dark: "oklch(0.72 0.03 258)" },
  };

  /**
   * The values as `PASTE_HINT` in `ConnectDialog.tsx:54` held them before the
   * move onto the descriptor. That table no longer exists; this is the record of
   * what it said.
   *
   * Added after review found this was the one moved field with no pin anywhere:
   * mutating anthropic's hint, and deleting custom's outright, both survived the
   * full core suite. Only openai's and kilo's were covered, incidentally, by a
   * dashboard connect test.
   */
  const PASTE_HINTS_BEFORE: Readonly<Record<BuiltIn, string>> = {
    anthropic: "Authorize in the browser, then paste the code Anthropic shows you.",
    openai: "Authorize in the browser. When it redirects to localhost, paste the whole URL.",
    kimi: "Enter the code on Kimi's device page. This dialog finishes on its own.",
    kilo: "Approve the code on Kilo's device page. This dialog finishes on its own.",
    grok: "Authorize in the browser. When it redirects to 127.0.0.1, paste the whole URL.",
    antigravity:
      "Approve in any browser, then paste the whole URL it lands on. A code shown on its own works too.",
    muse: "Enter the code on Meta's device page. This dialog finishes on its own.",
    custom: "Enter endpoint metadata and API key.",
  };

  /** `PROVIDER_ORDER` from `AccountsBoard.tsx`, as a rank per id. */
  const ORDER_BEFORE: readonly BuiltIn[] = [
    "anthropic",
    "openai",
    "kimi",
    "kilo",
    "grok",
    "antigravity",
    "muse",
    "custom",
  ];

  test("model prefixes match", () => {
    for (const id of IDS) {
      expect(entry(PROVIDER_DESCRIPTORS, id, "PROVIDER_DESCRIPTORS").modelPrefixes).toEqual(
        PREFIXES_BEFORE[id],
      );
    }
  });

  test("callbacks match, and only the two loopback providers have one", () => {
    for (const id of IDS) {
      expect(entry(PROVIDER_DESCRIPTORS, id, "PROVIDER_DESCRIPTORS").callback).toEqual(
        CALLBACKS_BEFORE[id],
      );
    }
  });

  test("labels, tones and colours match", () => {
    for (const id of IDS) {
      const { label, tone, colour } = entry(
        PROVIDER_DESCRIPTORS,
        id,
        "PROVIDER_DESCRIPTORS",
      ).presentation;
      expect(label).toBe(LABELS_BEFORE[id]);
      expect(tone).toBe(TONES_BEFORE[id]);
      expect(colour).toEqual(COLOURS_BEFORE[id]);
    }
  });

  test("paste hints match, and every provider states one", () => {
    for (const id of IDS) {
      expect(entry(PROVIDER_DESCRIPTORS, id, "PROVIDER_DESCRIPTORS").presentation.pasteHint).toBe(
        PASTE_HINTS_BEFORE[id],
      );
    }
  });

  test("display order matches, and every rank is distinct", () => {
    const ranked = [...IDS].sort(
      (a, b) =>
        entry(PROVIDER_DESCRIPTORS, a, "PROVIDER_DESCRIPTORS").presentation.order -
        entry(PROVIDER_DESCRIPTORS, b, "PROVIDER_DESCRIPTORS").presentation.order,
    );
    expect(ranked).toEqual([...ORDER_BEFORE]);

    // Two providers sharing a rank sort unpredictably, so the board's order
    // would depend on object key order rather than on anything stated.
    const ranks = IDS.map(
      (id) => entry(PROVIDER_DESCRIPTORS, id, "PROVIDER_DESCRIPTORS").presentation.order,
    );
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  test("every provider states a colour for both themes", () => {
    // A provider with only one renders colourless in the other, and nothing
    // throws — the CSS custom property simply resolves to nothing.
    for (const id of IDS) {
      const { light, dark } = entry(PROVIDER_DESCRIPTORS, id, "PROVIDER_DESCRIPTORS").presentation
        .colour;
      expect(light.length).toBeGreaterThan(0);
      expect(dark.length).toBeGreaterThan(0);
      expect(light).not.toBe(dark);
    }
  });
});

describe("the registry agrees with what it replaced", () => {
  test("every adapter reports the capabilities its descriptor states", () => {
    // The adapters used to read `PROVIDER_CAPABILITIES` from `@omni/ir`. They
    // now read their own descriptor, so this is what stops the two from
    // drifting — an adapter restating a literal would pass every other test here.
    for (const id of IDS) {
      expect(entry(PROVIDERS, id, "PROVIDERS").adapter.capabilities).toEqual(
        entry(PROVIDER_DESCRIPTORS, id, "PROVIDER_DESCRIPTORS").capabilities,
      );
    }
  });

  test("every entry joins its own profile and body order, not another's", () => {
    // Identity per id. A mutant that joined one provider's profile to every
    // entry survived the whole suite before this existed: `PROVIDERS` has no
    // production consumer, so nothing else reads the join at all.
    for (const id of IDS) {
      expect(entry(PROVIDERS, id, "PROVIDERS").profile).toBe(entry(PROFILES, id, "PROFILES"));
      expect(entry(PROVIDERS, id, "PROVIDERS").bodyOrder).toBe(entry(BODY_ORDER, id, "BODY_ORDER"));
    }
    // And the joined values are actually distinguishable, so the assertions
    // above cannot pass by every provider sharing one object.
    expect(new Set(IDS.map((id) => entry(PROVIDERS, id, "PROVIDERS").profile)).size).toBe(
      IDS.length,
    );
  });

  test("every entry joins the adapter that serves it", () => {
    for (const id of IDS) {
      expect(entry(PROVIDERS, id, "PROVIDERS").adapter).toBe(entry(ADAPTERS, id, "ADAPTERS"));
      expect(entry(PROVIDERS, id, "PROVIDERS").adapter.id).toBe(id);
    }
  });
});
