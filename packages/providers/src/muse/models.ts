import type { ProviderModelCatalogEntry } from "../catalog-types.ts";

/**
 * Muse Spark's published models and their list prices.
 *
 * Prices and limits checked 2026-09-05 against Meta's Muse Code product page,
 * which states a four-row table: a full-price and a `-contributor` variant of
 * each of 1.3 and 1.2, all four at a 1M context window.
 *
 * **The `-contributor` variants are twelve times cheaper because Meta trains on
 * the traffic.** The page's own words are "used to improve our products" for
 * those two and "not used to improve our products" for the other two. That is a
 * disclosure decision rather than a price tier, so it is in the label where an
 * operator picking a model has to read it — a catalog that showed only the
 * price would have the cheap row look like the obvious default.
 *
 * `maxOutputTokens` is the published 943,718 for 1.3. The figure is stated for
 * 1.3 alone and carried to 1.2 on the strength of otherwise identical headline
 * specs, which is an assumption rather than a reading; a target that hits it
 * should have its own figure set. Limits are advertised, never enforced, so the
 * cost of being wrong here is a wrong number in `GET /v1/models` rather than a
 * refused request.
 */
export const MUSE_MODELS: ProviderModelCatalogEntry = {
  defaultModel: "muse-spark-1.3",
  // A Muse Code subscription is spent minting a Model API key, and a key made
  // at dev.meta.ai reaches the same front door. Both are bearer tokens against
  // one host, so unlike OpenAI there is no narrower OAuth surface to describe
  // and no `oauthLimits` on any entry here.
  authTypes: ["oauth", "apiKey"],
  models: [
    {
      id: "muse-spark-1.3",
      label: "Muse Spark 1.3",
      pricing: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: 943_718 },
    },
    {
      id: "muse-spark-1.3-contributor",
      label: "Muse Spark 1.3 — Meta trains on this traffic",
      pricing: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: 943_718 },
    },
    {
      id: "muse-spark-1.2",
      label: "Muse Spark 1.2",
      pricing: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: 943_718 },
    },
    {
      id: "muse-spark-1.2-contributor",
      label: "Muse Spark 1.2 — Meta trains on this traffic",
      pricing: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: 943_718 },
    },
  ],
};
