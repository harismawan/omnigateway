import type { ProviderModelCatalogEntry } from "../catalog-types.ts";

/**
 * Anthropic's curated models and their list prices.
 *
 * Prices checked 2026-08-08 against Anthropic's published API pricing. Cache
 * reads are a flat 0.1x of base input across the range, expanded here into
 * absolute figures because a target stores a number, not a multiplier.
 *
 * Note: Claude Sonnet 5 carries an introductory $2.00 / $10.00 rate through
 * 2026-08-31. The standard rate is used here so a model configured today still
 * prices correctly in September; edit the target if the intro rate applies.
 */
export const ANTHROPIC_MODELS: ProviderModelCatalogEntry = {
  defaultModel: "claude-opus-5",
  models: [
    {
      id: "claude-fable-5",
      label: "Claude Fable 5",
      pricing: { input: 10, output: 50, cacheRead: 1 },
    },
    {
      id: "claude-opus-5",
      label: "Claude Opus 5",
      pricing: { input: 5, output: 25, cacheRead: 0.5 },
    },
    {
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      pricing: { input: 3, output: 15, cacheRead: 0.3 },
    },
    {
      id: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      pricing: { input: 1, output: 5, cacheRead: 0.1 },
    },
  ],
};
