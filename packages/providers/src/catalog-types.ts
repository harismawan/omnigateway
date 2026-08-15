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

/**
 * How a credential authenticates, which for one provider decides which backend
 * serves it. Spelled out here rather than imported from `@omni/store` so the
 * catalog stays a leaf the browser bundle can pull in on its own.
 */
export type CatalogAuth = "oauth" | "apiKey";

/**
 * How much a model can read and write, in tokens.
 *
 * Defaults in the same sense as pricing: a target stores its own figures and
 * the router never reads this table. They exist because a client asks the
 * gateway how much context it has — `GET /v1/models` reports them — and a
 * gateway that says nothing is read as the client's own default, which is
 * 200K for every model regardless of what the model actually holds.
 */
export type ProviderModelLimits = {
  /** Total prompt window the provider accepts. */
  contextWindow: number;
  /** Ceiling on one response, which is a separate limit from the window. */
  maxOutputTokens: number;
};

/**
 * Which shape of thinking request a model accepts.
 *
 * The two forms are not interchangeable: a model on the older fixed-budget API
 * rejects `{type:"adaptive"}` outright, so an adaptive request routed there
 * fails upstream rather than degrading. Recorded per model because the split
 * runs by model generation, not by provider or by credential.
 */
export type ProviderReasoningForm = "adaptive" | "budget";

export type ProviderModelChoice = {
  id: string;
  label: string;
  /** Published list price when this entry was last checked; see the file header. */
  pricing: ProviderModelPricing;
  /** Published context and output limits when this entry was last checked. */
  limits: ProviderModelLimits;
  /**
   * The same model's limits when it is reached through the provider's OAuth
   * backend, on the providers where that is a different and narrower surface.
   * Absent means one set of limits covers both ways in.
   */
  oauthLimits?: ProviderModelLimits;
  /**
   * Which credential types can reach this model, where a provider does not
   * serve the same catalog to both. Absent means both, which is the normal
   * case — Kilo's free tier and its `kilo-auto/*` routers are gateway-only, so
   * an OAuth credential cannot serve them.
   */
  auth?: readonly CatalogAuth[];
  /**
   * The thinking wire form this model speaks. Absent means `"adaptive"`, which
   * is the current form and the one a newly published model uses; only a model
   * left behind on the fixed-budget API states it.
   */
  reasoningForm?: ProviderReasoningForm;
};

export type ProviderModelCatalogEntry = {
  defaultModel: string;
  /**
   * Which kinds of credential the gateway can hold for this provider — the
   * values a stored credential's `authType` may take.
   *
   * Deliberately here rather than derived from `models[].auth`. The two answer
   * different questions: `auth` on a choice says which backend serves *that
   * model* where a provider splits its catalog, and `custom` proves they are
   * not the same fact — it lists no models at all and is nonetheless the one
   * provider reachable by key alone. Deriving would have read that empty list
   * as "no way in".
   *
   * Required, not optional, so a new provider has to state it. An `apiKey`
   * entry here is a promise the console makes to an operator: it puts a key
   * field in front of them. Claim it only where the adapter authenticates with
   * a raw key.
   */
  authTypes: readonly CatalogAuth[];
  models: readonly ProviderModelChoice[];
};
