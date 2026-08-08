import type { ProviderId } from "@omni/ir";
import { ANTHROPIC_MODELS } from "./anthropic/models.ts";
import type { ProviderModelChoice, ProviderModelPricing } from "./catalog-types.ts";
import { KIMI_MODELS } from "./kimi/models.ts";
import { OPENAI_MODELS } from "./openai/models.ts";

export type {
  ProviderModelCatalogEntry,
  ProviderModelChoice,
  ProviderModelPricing,
} from "./catalog-types.ts";

/**
 * Every provider's curated models, assembled from the per-provider lists.
 *
 * This module is deliberately free of imports beyond those lists and a type, so
 * `@omni/providers/catalog` can be pulled into a browser bundle without
 * dragging the HTTP client and adapters along with it. Adding a runtime import
 * here would silently undo that.
 *
 * The catalog is a source of *defaults*, never of truth: the router prices a
 * request from the target the operator saved. Editing an entry changes what a
 * new target starts with, and leaves configured models alone.
 */
export const PROVIDER_MODEL_CATALOG = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  kimi: KIMI_MODELS,
} as const satisfies Readonly<
  Record<ProviderId, { defaultModel: string; models: readonly ProviderModelChoice[] }>
>;

/** The catalog's price for one provider model, or null if it is not listed. */
export function catalogPricing(provider: ProviderId, model: string): ProviderModelPricing | null {
  return (
    PROVIDER_MODEL_CATALOG[provider].models.find((entry) => entry.id === model)?.pricing ?? null
  );
}
