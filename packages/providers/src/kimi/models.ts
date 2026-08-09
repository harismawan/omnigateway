import type { ProviderModelCatalogEntry } from "../catalog-types.ts";

/**
 * Kimi's curated models and their list prices.
 *
 * Prices checked 2026-08-08 against Moonshot's published API pricing. K3 is
 * flat across its full 1M context — there is no long-context premium — so the
 * 256K and 1M entries share a price and differ only in the window they request.
 *
 * The coding endpoints are K2.7 Code: the high-speed variant doubles the output
 * price for roughly 180 tokens/s and leaves input untouched.
 *
 * Limits checked 2026-08-09 against Moonshot's model guides. The two K3 entries
 * differ only in the window they request, so their limits are the one place
 * they diverge. Output is 131,072 throughout: K3's `max_completion_tokens`
 * defaults to that and is documented as raisable to 1,048,576, but the raised
 * ceiling equals the whole context window, so a client that sized a request to
 * the pair would build one that cannot fit. K2.7 Code defaults to 32,768 with
 * the same 131,072 ceiling, over a 256K window.
 */
export const KIMI_MODELS: ProviderModelCatalogEntry = {
  defaultModel: "k3-256k",
  models: [
    {
      id: "k3-256k",
      label: "Kimi K3 — 256K",
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 262_144, maxOutputTokens: 131_072 },
    },
    {
      id: "k3",
      label: "Kimi K3 — up to 1M",
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
    },
    {
      id: "kimi-for-coding",
      label: "Kimi K2.7 Code",
      pricing: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 262_144, maxOutputTokens: 131_072 },
    },
    {
      id: "kimi-for-coding-highspeed",
      label: "Kimi K2.7 Code — High Speed",
      pricing: { input: 0.95, output: 8, cacheRead: 0.19, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 262_144, maxOutputTokens: 131_072 },
    },
  ],
};
