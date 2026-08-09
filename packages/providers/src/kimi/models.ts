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
 */
export const KIMI_MODELS: ProviderModelCatalogEntry = {
  defaultModel: "k3-256k",
  models: [
    {
      id: "k3-256k",
      label: "Kimi K3 — 256K",
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 0, cacheWrite1h: 0 },
    },
    {
      id: "k3",
      label: "Kimi K3 — up to 1M",
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 0, cacheWrite1h: 0 },
    },
    {
      id: "kimi-for-coding",
      label: "Kimi K2.7 Code",
      pricing: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite5m: 0, cacheWrite1h: 0 },
    },
    {
      id: "kimi-for-coding-highspeed",
      label: "Kimi K2.7 Code — High Speed",
      pricing: { input: 0.95, output: 8, cacheRead: 0.19, cacheWrite5m: 0, cacheWrite1h: 0 },
    },
  ],
};
