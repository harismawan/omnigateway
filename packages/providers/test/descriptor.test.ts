import { describe, expect, test } from "bun:test";
import { ANTHROPIC_NATIVE_TOOLS, PROVIDER_CAPABILITIES, type ProviderId } from "@omni/ir";
import { PROVIDER_MODEL_CATALOG } from "../src/catalog.ts";
import type { ProviderDescriptor } from "../src/descriptor.ts";
import { ADAPTERS, PROVIDER_DESCRIPTORS, PROVIDERS } from "../src/registry.ts";

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

/** Likewise for `ANTHROPIC_NATIVE_TOOLS`. */
const NATIVE_TOOLS_BEFORE: Readonly<Record<ProviderId, boolean>> = {
  anthropic: true,
  openai: false,
  kimi: false,
  kilo: false,
  grok: false,
  custom: false,
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
      expect(typeof descriptor.anthropicNativeTools).toBe("boolean");
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
      anthropicNativeTools: true,
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

  test("anthropicNativeTools matches the pre-change fixture", () => {
    for (const id of IDS) {
      expect(PROVIDER_DESCRIPTORS[id].anthropicNativeTools).toBe(NATIVE_TOOLS_BEFORE[id]);
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

describe("the registry agrees with what it replaced", () => {
  test("the live ir tables still match the descriptors", () => {
    // These two tables have not been deleted yet; while both exist they must
    // agree, or the migration has silently changed routing.
    for (const id of IDS) {
      expect(PROVIDER_DESCRIPTORS[id].capabilities).toEqual(PROVIDER_CAPABILITIES[id]);
      expect(PROVIDER_DESCRIPTORS[id].anthropicNativeTools).toBe(ANTHROPIC_NATIVE_TOOLS[id]);
    }
  });

  test("every entry joins the adapter that serves it", () => {
    for (const id of IDS) {
      expect(PROVIDERS[id].adapter).toBe(ADAPTERS[id]);
      expect(PROVIDERS[id].adapter.id).toBe(id);
    }
  });
});
