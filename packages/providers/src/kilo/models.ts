import type { ProviderModelCatalogEntry } from "../catalog-types.ts";

/**
 * Kilo's curated models, their list prices and their limits.
 *
 * Read from `GET https://api.kilo.ai/api/gateway/models` on 2026-08-15, which
 * answers unauthenticated. Kilo proxies several hundred models and passes each
 * vendor's list price through unchanged — its Anthropic rows match Anthropic's
 * own published rates exactly — so these figures are the upstream vendor's, not
 * a Kilo markup. The list here is a curated subset: the newest model of each
 * class, every model Kilo serves free, and the `kilo-auto/*` routers. A model
 * outside it is still reachable by typing its id into a target, which is how
 * `kimi` and `grok` already work; the only difference is that Kilo's upstream
 * list is larger and moves faster.
 *
 * Ids are Kilo's OpenRouter-style `vendor/model` form. The `-pro` variants of
 * each `gpt-5.6-*` and the `-fast` variants of the Anthropic models are left
 * out deliberately: listing every variant turns a curated table into a mirror
 * of a catalog that moves weekly.
 *
 * Limits are the exact integers `GET /api/gateway/models` reports, not rounded
 * figures: some rows are round decimals (1,000,000) and some are binary
 * (1,048,576, 262,144), because each is whatever the upstream vendor states.
 * They are not interchangeable — `GET /v1/models` advertises them to clients,
 * so rounding 1,048,576 up to 1,050,000 would offer a window ~1,400 tokens
 * wider than the model holds, and a client that sized a request to it would
 * build one the upstream rejects.
 *
 * Cache writes are recorded as one figure repeated across both TTLs, because
 * Kilo reports a single `input_cache_write` price and the chat completions wire
 * cannot express a cache-control TTL at all. A request carrying breakpoints
 * records a degradation instead, so neither figure is ever actually charged.
 * The Anthropic, OpenAI and Google rows all carry a write price; Moonshot's row
 * and the routers report none, which is a real zero rather than a missing one.
 */
export const KILO_MODELS: ProviderModelCatalogEntry = {
  // A priced model reachable on both ways in, rather than a `kilo-auto/*`
  // router: those are gateway-only and state no price at all.
  defaultModel: "anthropic/claude-sonnet-5",
  // Both, and the two are not interchangeable: the adapter picks the OpenRouter
  // path for a device token and the gateway path for a key. Which is also why
  // `auth` appears on individual choices below — a key reaches strictly more of
  // Kilo's catalog than a subscription does.
  authTypes: ["oauth", "apiKey"],
  models: [
    // --- Frontier, one per class ------------------------------------------
    {
      id: "anthropic/claude-fable-5",
      label: "Claude Fable 5",
      pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 12.5 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    },
    {
      id: "anthropic/claude-opus-5",
      label: "Claude Opus 5",
      pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 6.25 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    },
    {
      id: "anthropic/claude-sonnet-5",
      // Kilo reports Sonnet 5's introductory $2/$10, not the standard rate.
      label: "Claude Sonnet 5",
      pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 2.5 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    },
    {
      id: "anthropic/claude-haiku-4.5",
      label: "Claude Haiku 4.5",
      pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 1.25 },
      limits: { contextWindow: 200_000, maxOutputTokens: 64_000 },
    },
    {
      id: "openai/gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 6.25 },
      limits: { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    },
    {
      id: "openai/gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 2.5 },
      limits: { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    },
    {
      id: "openai/gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      pricing: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite5m: 0.25, cacheWrite1h: 0.25 },
      limits: { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    },
    {
      id: "google/gemini-3.1-pro-preview",
      label: "Gemini 3.1 Pro Preview",
      pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite5m: 0.375, cacheWrite1h: 0.375 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: 65_536 },
    },
    {
      id: "google/gemini-3.7-flash",
      label: "Gemini 3.7 Flash",
      pricing: {
        input: 0.75,
        output: 3.75,
        cacheRead: 0.075,
        // Transcribed to the digit Kilo reports it to, not rounded: this row is
        // the one figure in the table that is not a clean fraction of input.
        cacheWrite5m: 0.041667,
        cacheWrite1h: 0.041667,
      },
      limits: { contextWindow: 1_048_576, maxOutputTokens: 65_536 },
    },
    {
      id: "moonshotai/kimi-k3",
      label: "Kimi K3",
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 0, cacheWrite1h: 0 },
      // Kilo states no completion limit for this row. Recorded as Moonshot's
      // own documented K3 ceiling — the same figure `KIMI_MODELS` carries —
      // rather than as zero, which `/v1/models` would advertise as a model
      // that cannot answer.
      limits: { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
    },

    // --- Free tier ---------------------------------------------------------
    // Priced 0 because 0 is what they cost. Gateway-only: the OpenRouter path
    // an OAuth credential is served by does not carry them.
    {
      id: "nvidia/nemotron-3-ultra-550b-a55b:free",
      label: "Nemotron 3 Ultra 550B — free",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 65_536 },
      auth: ["apiKey"],
    },
    {
      id: "nvidia/nemotron-3.5-lightning:free",
      label: "Nemotron 3.5 Lightning — free",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 65_536 },
      auth: ["apiKey"],
    },
    {
      id: "dots-studio/dots-3-note-preview:free",
      label: "Dots 3 Note Preview — free",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 512_000, maxOutputTokens: 512_000 },
      auth: ["apiKey"],
    },
    {
      id: "cohere/north-mini-code:free",
      label: "North Mini Code — free",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 256_000, maxOutputTokens: 64_000 },
      auth: ["apiKey"],
    },
    {
      id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      label: "Nemotron 3 Nano Omni 30B Reasoning — free",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 256_000, maxOutputTokens: 65_536 },
      auth: ["apiKey"],
    },
    {
      id: "stepfun/step-3.7-flash:free",
      label: "Step 3.7 Flash — free",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 262_144, maxOutputTokens: 262_144 },
      auth: ["apiKey"],
    },
    {
      id: "nvidia/nemotron-3-super-120b-a12b:free",
      label: "Nemotron 3 Super 120B — free",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 262_144, maxOutputTokens: 262_144 },
      auth: ["apiKey"],
    },
    {
      id: "tencent/hy3:free",
      label: "Tencent HY3 — free",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 262_144, maxOutputTokens: 128_000 },
      auth: ["apiKey"],
    },
    {
      id: "poolside/laguna-s-2.1:free",
      label: "Laguna S 2.1 — free",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 262_144, maxOutputTokens: 32_768 },
      auth: ["apiKey"],
    },
    {
      id: "poolside/laguna-xs-2.1:free",
      label: "Laguna XS 2.1 — free",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 262_144, maxOutputTokens: 32_768 },
      auth: ["apiKey"],
    },
    {
      id: "liquid/lfm-2.5-2.6b:free",
      label: "LFM 2.5 2.6B — free",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 128_000, maxOutputTokens: 8_192 },
      auth: ["apiKey"],
    },
    {
      id: "nvidia/nemotron-3.5-content-safety:free",
      label: "Nemotron 3.5 Content Safety — free",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 128_000, maxOutputTokens: 8_192 },
      auth: ["apiKey"],
    },

    // --- Routers -----------------------------------------------------------
    // `kilo-auto/*` picks an upstream per request, so Kilo reports `"prompt":
    // "-1"` for the three tiered routers: it declines to state a price rather
    // than serving them free. The 0 recorded here is read by the router's
    // scorer as *unpriced* and dropped from the cost term, which is the correct
    // behaviour — but it is the same stored value `kilo-auto/free` carries for
    // the opposite reason, so each says which it is. An operator who wants one
    // of these cost-ranked sets a real `costPerMTok` on the target.
    {
      id: "kilo-auto/frontier",
      label: "Kilo Auto — Frontier",
      // Unpriced: chosen per request, no rate stated upstream.
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      auth: ["apiKey"],
    },
    {
      id: "kilo-auto/balanced",
      label: "Kilo Auto — Balanced",
      // Unpriced, as above.
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 65_536 },
      auth: ["apiKey"],
    },
    {
      id: "kilo-auto/efficient",
      label: "Kilo Auto — Efficient",
      // Unpriced, as above.
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 65_536 },
      auth: ["apiKey"],
    },
    {
      id: "kilo-auto/small",
      label: "Kilo Auto — Small",
      // The one router that states a rate, and it states a full one.
      pricing: { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 262_144, maxOutputTokens: 32_768 },
      auth: ["apiKey"],
    },
    {
      id: "kilo-auto/free",
      label: "Kilo Auto — Free",
      // Genuinely free: 0 is this router's real price, not a withheld one.
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 256_000, maxOutputTokens: 10_000 },
      auth: ["apiKey"],
    },
  ],
};
