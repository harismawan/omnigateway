import type { ProviderModelCatalogEntry } from "../catalog-types.ts";

/**
 * xAI's curated models and their list prices.
 *
 * One list covers both ways in: the API host and the cli-chat-proxy serve the
 * same slugs, so unlike OpenAI there is no narrower OAuth surface to record.
 *
 * Prices checked 2026-08-15 against xAI's published pricing. xAI has no
 * cache-write class at all, so both write figures are zero — a real price, not
 * a missing one. The figures here are the **sub-200K** rates: xAI prices by
 * request size and roughly doubles at or above 200K context, applying the
 * higher rate to every token in the request rather than to the overage. The
 * catalog cannot express that, and it is only a default for a newly created
 * target, so an operator running long-context traffic edits the stored price.
 *
 * `maxOutputTokens` is 128,000 throughout, and it is a documented API *default*
 * rather than a model ceiling: `max_output_tokens` "defaults to 128,000 when
 * unset; set a larger value to allow longer generations", and grok-4.6's own
 * overview states "no text output limit". An operator may raise it, and the
 * proxy reports the live value back on `x-grok-max-completion-tokens`.
 *
 * Two absences are deliberate. `grok-build-0.1` is a prompt-suggestion model in
 * xAI's own source, not a chat model, despite third-party tables listing it.
 * The `grok-4*` and `grok-code-fast-1` families retired on 15 May 2026: their
 * slugs still resolve but silently redirect, so listing them would offer a
 * target whose real identity and price differ from what this table says.
 */
export const GROK_MODELS: ProviderModelCatalogEntry = {
  defaultModel: "grok-4.6",
  models: [
    {
      id: "grok-4.6",
      label: "Grok 4.6",
      pricing: { input: 2, output: 6, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 500_000, maxOutputTokens: 128_000 },
    },
    {
      id: "grok-4.5",
      label: "Grok 4.5",
      pricing: { input: 2, output: 6, cacheRead: 0.3, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 500_000, maxOutputTokens: 128_000 },
    },
    {
      id: "grok-4.3",
      label: "Grok 4.3",
      pricing: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    },
    {
      id: "grok-4.20-0309-reasoning",
      label: "Grok 4.20 — reasoning",
      pricing: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    },
    {
      id: "grok-4.20-0309-non-reasoning",
      label: "Grok 4.20 — non-reasoning",
      pricing: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    },
    {
      id: "grok-4.20-multi-agent-0309",
      label: "Grok 4.20 — multi-agent",
      pricing: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    },
  ],
};
