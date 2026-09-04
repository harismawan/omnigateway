import type { ProviderModelCatalogEntry } from "../catalog-types.ts";

/**
 * OpenAI's curated models and their list prices.
 *
 * Prices checked 2026-09-04 against OpenAI's published API pricing. Cache reads
 * keep the 90% discount, so each cache-read figure is a tenth of that tier's
 * input price.
 *
 * OpenAI prices these models in two context tiers, split at 272,000 input
 * tokens. **The figures here are the short-context tier**, because that is the
 * tier every request through an OAuth credential is billed at: the Codex
 * backend caps the window at 272,000, so it cannot reach the long tier at all.
 * An API-key deployment that routinely sends more than 272K should raise its
 * target's prices — the long tier is roughly double on input and half again on
 * output. The bare `gpt-5.6` alias routes to Sol and is priced as Sol.
 *
 * Limits checked 2026-09-04 against OpenAI's model pages, which state three
 * figures for both generations: a 1,050,000 context window, a 922,000 cap on
 * input alone, and 128,000 output tokens. `contextWindow` records the input cap
 * rather than the window, because it is advertised as the size of prompt a
 * client may send: a client told 1,050,000 would fill 1.05M and be rejected
 * upstream at 922K. Astra, Sol, Terra and Luna are identical in all three.
 *
 * `oauthLimits` is the Codex backend, which an OAuth credential is routed to
 * and which is narrower than the API in context as well as in parameters: its
 * bundled catalog caps the window at 272,000 input tokens, where the API takes
 * 922,000. Output is 128,000 either way. It is stated on every entry, including
 * ones Codex may not serve at all, so that a model Codex does start serving is
 * never advertised the API's window by default.
 */
export const OPENAI_MODELS: ProviderModelCatalogEntry = {
  defaultModel: "gpt-5.6",
  // OAuth reaches the narrower Codex surface; a platform key reaches the API.
  // Both are bearer tokens, and the adapter picks the URL from which it has.
  authTypes: ["oauth", "apiKey"],
  models: [
    {
      id: "gpt-6-astra",
      label: "GPT-6 Astra",
      pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 922_000, maxOutputTokens: 128_000 },
      oauthLimits: { contextWindow: 272_000, maxOutputTokens: 128_000 },
    },
    {
      id: "gpt-5.6",
      label: "GPT-5.6 — routes to Sol",
      pricing: { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 922_000, maxOutputTokens: 128_000 },
      oauthLimits: { contextWindow: 272_000, maxOutputTokens: 128_000 },
    },
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      pricing: { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 922_000, maxOutputTokens: 128_000 },
      oauthLimits: { contextWindow: 272_000, maxOutputTokens: 128_000 },
    },
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 922_000, maxOutputTokens: 128_000 },
      oauthLimits: { contextWindow: 272_000, maxOutputTokens: 128_000 },
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      pricing: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 922_000, maxOutputTokens: 128_000 },
      oauthLimits: { contextWindow: 272_000, maxOutputTokens: 128_000 },
    },
  ],
};
