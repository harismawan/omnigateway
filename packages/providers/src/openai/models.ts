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
 *
 * Limits checked 2026-08-09 against OpenAI's model pages, which state three
 * figures for the 5.6 generation: a 1,050,000 context window, a 922,000 cap on
 * input alone, and 128,000 output tokens. `contextWindow` records the input cap
 * rather than the window, because it is advertised as the size of prompt a
 * client may send: a client told 1,050,000 would fill 1.05M and be rejected
 * upstream at 922K. Sol, Terra and Luna are identical in all three.
 *
 * `oauthLimits` is the Codex backend, which an OAuth credential is routed to
 * and which is narrower than the API in context as well as in parameters: its
 * bundled catalog caps the window at 272,000 input tokens for all three tiers,
 * where the API takes 922,000. Output is 128,000 either way. 272,000 is also
 * where the API's long-context pricing starts, which is why the same number
 * turns up in the note above about raising a target's prices.
 */
export const OPENAI_MODELS: ProviderModelCatalogEntry = {
  defaultModel: "gpt-5.6",
  // OAuth reaches the narrower Codex surface; a platform key reaches the API.
  // Both are bearer tokens, and the adapter picks the URL from which it has.
  authTypes: ["oauth", "apiKey"],
  models: [
    {
      id: "gpt-5.6",
      label: "GPT-5.6 — routes to Sol",
      pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 922_000, maxOutputTokens: 128_000 },
      oauthLimits: { contextWindow: 272_000, maxOutputTokens: 128_000 },
    },
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol — deepest reasoning",
      pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 922_000, maxOutputTokens: 128_000 },
      oauthLimits: { contextWindow: 272_000, maxOutputTokens: 128_000 },
    },
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6 Terra — balanced",
      pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 922_000, maxOutputTokens: 128_000 },
      oauthLimits: { contextWindow: 272_000, maxOutputTokens: 128_000 },
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna — fastest",
      pricing: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 922_000, maxOutputTokens: 128_000 },
      oauthLimits: { contextWindow: 272_000, maxOutputTokens: 128_000 },
    },
  ],
};
