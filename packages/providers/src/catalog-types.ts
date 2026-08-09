/**
 * Shape of a provider's curated model list.
 *
 * Each provider owns its own catalog next to its adapter, and `catalog.ts`
 * assembles them. This module holds only the types so the three provider
 * catalogs do not import each other.
 */

/**
 * List price in US dollars per million tokens.
 *
 * These are the operator's *defaults* — the router reads whatever is stored on
 * a target, never this table. A provider that prices cache reads at a flat
 * fraction of input still gets an explicit number here rather than a formula,
 * because the gateway stores an absolute figure.
 */
export type ProviderModelPricing = {
  input: number;
  output: number;
  cacheRead: number;
  /**
   * Cache writes, by the TTL each buys. Zero where a provider caches
   * automatically and bills no premium for creating an entry — a real price,
   * not a missing one.
   */
  cacheWrite5m: number;
  cacheWrite1h: number;
};

export type ProviderModelChoice = {
  id: string;
  label: string;
  /** Published list price when this entry was last checked; see the file header. */
  pricing: ProviderModelPricing;
};

export type ProviderModelCatalogEntry = {
  defaultModel: string;
  models: readonly ProviderModelChoice[];
};
