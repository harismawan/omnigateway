import type { ProviderModelCatalogEntry } from "../catalog-types.ts";

/**
 * OpenAI's curated models and their list prices.
 *
 * Prices checked 2026-08-08 against OpenAI's published API pricing, after the
 * 2026-07-30 cut to Luna and Terra. Cache reads keep the 90% discount, so each
 * cache-read figure is a tenth of that tier's input price.
 *
 * The bare `gpt-5.6` alias routes to Sol and is priced as Sol. Long-context
 * requests are billed at a higher rate than the figures here; a deployment that
 * routinely exceeds the standard threshold should raise its target's prices.
 */
export const OPENAI_MODELS: ProviderModelCatalogEntry = {
  defaultModel: "gpt-5.6",
  models: [
    {
      id: "gpt-5.6",
      label: "GPT-5.6 — routes to Sol",
      pricing: { input: 5, output: 30, cacheRead: 0.5 },
    },
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol — deepest reasoning",
      pricing: { input: 5, output: 30, cacheRead: 0.5 },
    },
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6 Terra — balanced",
      pricing: { input: 2, output: 12, cacheRead: 0.2 },
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna — fastest",
      pricing: { input: 0.2, output: 1.2, cacheRead: 0.02 },
    },
  ],
};
