import { describe, expect, test } from "bun:test";
import type { ProviderId } from "@omni/ir";
import { BODY_ORDER } from "../src/body.ts";
import { PROVIDER_MODEL_CATALOG } from "../src/catalog.ts";
import type { ProviderDescriptor } from "../src/descriptor.ts";
import { PROVIDER_DESCRIPTORS } from "../src/descriptors.ts";
import { PROFILES } from "../src/profile.ts";
import { ADAPTERS, PROVIDERS } from "../src/registry.ts";

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
  "custom",
] as const satisfies readonly ProviderId[];

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
const WRITE_OVER_INPUT_BEFORE: Readonly<
  Record<ProviderId, { fiveMinute: number; oneHour: number }>
> = {
  anthropic: { fiveMinute: 1.25, oneHour: 2 },
  openai: { fiveMinute: 0, oneHour: 0 },
  kimi: { fiveMinute: 0, oneHour: 0 },
  kilo: { fiveMinute: 0, oneHour: 0 },
  grok: { fiveMinute: 0, oneHour: 0 },
  custom: { fiveMinute: 0, oneHour: 0 },
};

/** Likewise for `PROVIDER_CAPABILITIES`, as it stood in `packages/ir`. */
const CAPABILITIES_BEFORE: Readonly<
  Record<ProviderId, { tools: boolean; images: boolean; reasoning: boolean }>
> = {
  anthropic: { tools: true, images: true, reasoning: true },
  openai: { tools: true, images: true, reasoning: true },
  kimi: { tools: true, images: false, reasoning: false },
  kilo: { tools: true, images: true, reasoning: true },
  grok: { tools: true, images: true, reasoning: true },
  custom: { tools: true, images: true, reasoning: true },
};

describe("the registry describes every provider", () => {
  test("one descriptor per id, and no others", () => {
    expect(Object.keys(PROVIDER_DESCRIPTORS).sort()).toEqual([...IDS].sort());
    expect(Object.keys(PROVIDERS).sort()).toEqual([...IDS].sort());
  });

  test("every descriptor is complete", () => {
    // Required with no defaults: a missing `writeOverInput` must be a loud
    // failure here rather than a zero that underprices cache writes for good.
    for (const id of IDS) {
      const descriptor = PROVIDER_DESCRIPTORS[id];
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
    // against a validator that does nothing. This is a compile-time guarantee,
    // so the assertion is that the cast is needed at all: remove `writeOverInput`
    // from `ProviderDescriptor` and this stops being an error.
    const incomplete = {
      id: "anthropic",
      capabilities: { tools: true, images: true, reasoning: true },
      catalog: PROVIDER_MODEL_CATALOG.anthropic,
    };
    // @ts-expect-error — `writeOverInput` is required and absent.
    const rejected: ProviderDescriptor = incomplete;
    expect(rejected).toBeDefined();
  });
});

describe("descriptors carry the values the old tables held", () => {
  test("capabilities match the pre-change fixture", () => {
    for (const id of IDS) {
      expect(PROVIDER_DESCRIPTORS[id].capabilities).toEqual(CAPABILITIES_BEFORE[id]);
    }
  });

  test("writeOverInput matches the pre-change fixture", () => {
    for (const id of IDS) {
      expect(PROVIDER_DESCRIPTORS[id].writeOverInput).toEqual(WRITE_OVER_INPUT_BEFORE[id]);
    }
  });

  test("the catalog entry is the same object the catalog subpath serves", () => {
    // Identity, not deep equality: the descriptor must reference the provider's
    // own models list rather than hold a copy of it, or the browser-safe catalog
    // and the registry become two sources that can disagree.
    for (const id of IDS) {
      expect(PROVIDER_DESCRIPTORS[id].catalog).toBe(PROVIDER_MODEL_CATALOG[id]);
    }
  });
});

describe("presentation and routing data match their pre-change fixtures", () => {
  /** `PREFIX_PROVIDER` as it stood in `packages/router/src/resolve.ts`. */
  const PREFIXES_BEFORE: Readonly<Record<ProviderId, readonly string[]>> = {
    anthropic: ["claude-"],
    openai: ["gpt-", "o1", "o3", "o4"],
    kimi: ["kimi-", "moonshot"],
    kilo: [],
    grok: ["grok-"],
    custom: [],
  };

  /** `CALLBACKS` as it stood in `packages/control/src/connect.ts`. */
  const CALLBACKS_BEFORE: Readonly<Partial<Record<ProviderId, { uri: string; label: string }>>> = {
    openai: { uri: "http://localhost:1455/auth/callback", label: "OpenAI" },
    grok: { uri: "http://127.0.0.1:56121/callback", label: "Grok" },
  };

  /** `PROVIDER_LABEL`, which existed in three separate copies. */
  const LABELS_BEFORE: Readonly<Record<ProviderId, string>> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    kimi: "Kimi",
    kilo: "Kilo",
    grok: "Grok",
    custom: "OpenAI Compatible",
  };

  /** `PROVIDER_TONE` as it stood in `apps/cli/src/command.ts`. */
  const TONES_BEFORE: Readonly<Record<ProviderId, string>> = {
    anthropic: "magenta",
    openai: "green",
    kimi: "blue",
    kilo: "orange",
    grok: "yellow",
    custom: "cyan",
  };

  /** The `--p-<id>` custom properties, both themes, from `GlobalStyle.ts`. */
  const COLOURS_BEFORE: Readonly<Record<ProviderId, { light: string; dark: string }>> = {
    anthropic: { light: "oklch(0.56 0.13 45)", dark: "oklch(0.74 0.12 48)" },
    openai: { light: "oklch(0.5 0.09 190)", dark: "oklch(0.76 0.1 190)" },
    kimi: { light: "oklch(0.53 0.17 330)", dark: "oklch(0.72 0.16 330)" },
    kilo: { light: "oklch(0.52 0.14 224)", dark: "oklch(0.74 0.14 224)" },
    grok: { light: "oklch(0.52 0.14 125)", dark: "oklch(0.74 0.14 125)" },
    custom: { light: "oklch(0.5 0.03 258)", dark: "oklch(0.72 0.03 258)" },
  };

  /**
   * `PASTE_HINT` from `ConnectDialog.tsx:54`.
   *
   * Added after review found this was the one moved field with no pin anywhere:
   * mutating anthropic's hint, and deleting custom's outright, both survived the
   * full core suite. Only openai's and kilo's were covered, incidentally, by a
   * dashboard connect test.
   */
  const PASTE_HINTS_BEFORE: Readonly<Record<ProviderId, string>> = {
    anthropic: "Authorize in the browser, then paste the code Anthropic shows you.",
    openai: "Authorize in the browser. When it redirects to localhost, paste the whole URL.",
    kimi: "Enter the code on Kimi's device page. This dialog finishes on its own.",
    kilo: "Approve the code on Kilo's device page. This dialog finishes on its own.",
    grok: "Authorize in the browser. When it redirects to 127.0.0.1, paste the whole URL.",
    custom: "Enter endpoint metadata and API key.",
  };

  /** `PROVIDER_ORDER` from `AccountsBoard.tsx`, as a rank per id. */
  const ORDER_BEFORE: readonly ProviderId[] = [
    "anthropic",
    "openai",
    "kimi",
    "kilo",
    "grok",
    "custom",
  ];

  test("model prefixes match", () => {
    for (const id of IDS) {
      expect(PROVIDER_DESCRIPTORS[id].modelPrefixes).toEqual(PREFIXES_BEFORE[id]);
    }
  });

  test("callbacks match, and only the two loopback providers have one", () => {
    for (const id of IDS) {
      expect(PROVIDER_DESCRIPTORS[id].callback).toEqual(CALLBACKS_BEFORE[id]);
    }
  });

  test("labels, tones and colours match", () => {
    for (const id of IDS) {
      const { label, tone, colour } = PROVIDER_DESCRIPTORS[id].presentation;
      expect(label).toBe(LABELS_BEFORE[id]);
      expect(tone).toBe(TONES_BEFORE[id]);
      expect(colour).toEqual(COLOURS_BEFORE[id]);
    }
  });

  test("paste hints match, and every provider states one", () => {
    for (const id of IDS) {
      expect(PROVIDER_DESCRIPTORS[id].presentation.pasteHint).toBe(PASTE_HINTS_BEFORE[id]);
    }
  });

  test("display order matches, and every rank is distinct", () => {
    const ranked = [...IDS].sort(
      (a, b) =>
        PROVIDER_DESCRIPTORS[a].presentation.order - PROVIDER_DESCRIPTORS[b].presentation.order,
    );
    expect(ranked).toEqual([...ORDER_BEFORE]);

    // Two providers sharing a rank sort unpredictably, so the board's order
    // would depend on object key order rather than on anything stated.
    const ranks = IDS.map((id) => PROVIDER_DESCRIPTORS[id].presentation.order);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  test("every provider states a colour for both themes", () => {
    // A provider with only one renders colourless in the other, and nothing
    // throws — the CSS custom property simply resolves to nothing.
    for (const id of IDS) {
      const { light, dark } = PROVIDER_DESCRIPTORS[id].presentation.colour;
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
      expect(PROVIDERS[id].adapter.capabilities).toEqual(PROVIDER_DESCRIPTORS[id].capabilities);
    }
  });

  test("every entry joins its own profile and body order, not another's", () => {
    // Identity per id. A mutant that joined one provider's profile to every
    // entry survived the whole suite before this existed: `PROVIDERS` has no
    // production consumer, so nothing else reads the join at all.
    for (const id of IDS) {
      expect(PROVIDERS[id].profile).toBe(PROFILES[id]);
      expect(PROVIDERS[id].bodyOrder).toBe(BODY_ORDER[id]);
    }
    // And the joined values are actually distinguishable, so the assertions
    // above cannot pass by every provider sharing one object.
    expect(new Set(IDS.map((id) => PROVIDERS[id].profile)).size).toBe(IDS.length);
  });

  test("every entry joins the adapter that serves it", () => {
    for (const id of IDS) {
      expect(PROVIDERS[id].adapter).toBe(ADAPTERS[id]);
      expect(PROVIDERS[id].adapter.id).toBe(id);
    }
  });
});
