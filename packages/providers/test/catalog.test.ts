import { expect, test } from "bun:test";
import type { ProviderId } from "@omni/ir";
import { catalogPricing, PROVIDER_MODEL_CATALOG } from "../src/catalog.ts";

const PROVIDERS: readonly ProviderId[] = ["anthropic", "openai", "kimi", "grok", "custom"];

const EXPECTED = {
  anthropic: {
    defaultModel: "claude-opus-5",
    ids: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  },
  openai: {
    defaultModel: "gpt-5.6",
    ids: ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  },
  kimi: {
    defaultModel: "k3-256k",
    ids: ["k3-256k", "k3", "kimi-for-coding", "kimi-for-coding-highspeed"],
  },
  grok: {
    defaultModel: "grok-4.6",
    ids: [
      "grok-4.6",
      "grok-4.5",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-multi-agent-0309",
    ],
  },
  custom: { defaultModel: "", ids: [] },
} as const;

test("catalog covers every provider with ordered curated IDs", () => {
  expect(Object.keys(PROVIDER_MODEL_CATALOG).sort()).toEqual([...PROVIDERS].sort());

  for (const provider of PROVIDERS) {
    const entry = PROVIDER_MODEL_CATALOG[provider];
    expect(entry.defaultModel).toBe(EXPECTED[provider].defaultModel);
    expect(entry.models.map((model) => model.id)).toEqual([...EXPECTED[provider].ids]);
  }
});

test("catalog entries have non-empty unique values and exactly one default", () => {
  for (const provider of PROVIDERS) {
    const entry = PROVIDER_MODEL_CATALOG[provider];
    const ids = entry.models.map((model) => model.id);

    if (provider === "custom") {
      expect(entry.defaultModel).toBe("");
      expect(ids).toEqual([]);
      continue;
    }
    expect(entry.defaultModel.length).toBeGreaterThan(0);
    expect(entry.models.every((model) => model.id.length > 0 && model.label.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === entry.defaultModel)).toHaveLength(1);
  }
});

test("every model carries a usable price", () => {
  for (const provider of PROVIDERS) {
    for (const model of PROVIDER_MODEL_CATALOG[provider].models) {
      const { input, output, cacheRead } = model.pricing;
      // A zero price is read by the router as "unpriced", which would silently
      // remove this model from cost ranking.
      expect(input).toBeGreaterThan(0);
      expect(output).toBeGreaterThan(0);
      expect(cacheRead).toBeGreaterThan(0);
      // Output is never cheaper than input, and a cache read never costs more
      // than reading the same tokens fresh.
      expect(output).toBeGreaterThanOrEqual(input);
      expect(cacheRead).toBeLessThanOrEqual(input);
    }
  }
});

test("Kimi labels describe coding endpoint aliases", () => {
  expect(PROVIDER_MODEL_CATALOG.kimi.models.map((model) => model.label)).toEqual([
    "Kimi K3 — 256K",
    "Kimi K3 — up to 1M",
    "Kimi K2.7 Code",
    "Kimi K2.7 Code — High Speed",
  ]);
});

test("the high-speed coding endpoint doubles output and leaves input alone", () => {
  const standard = catalogPricing("kimi", "kimi-for-coding");
  const highspeed = catalogPricing("kimi", "kimi-for-coding-highspeed");
  if (standard === null || highspeed === null) throw new Error("coding endpoints are not listed");

  expect(highspeed.input).toBe(standard.input);
  expect(highspeed.output).toBe(standard.output * 2);
});

test("the bare OpenAI alias is priced as the tier it routes to", () => {
  expect(catalogPricing("openai", "gpt-5.6")).toEqual(catalogPricing("openai", "gpt-5.6-sol"));
});

test("catalogPricing reports an unlisted model rather than guessing", () => {
  expect(catalogPricing("anthropic", "claude-opus-5")).toEqual({
    input: 5,
    output: 25,
    cacheRead: 0.5,
    // 1.25x and 2x of base input, which is what Anthropic charges to create a
    // cache entry at each TTL.
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
  });
  expect(catalogPricing("anthropic", "some-model-we-do-not-list")).toBeNull();
  // A model listed under one provider is not priced under another.
  expect(catalogPricing("openai", "claude-opus-5")).toBeNull();
});
