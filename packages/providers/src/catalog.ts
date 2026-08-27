import type { ProviderId } from "@omni/ir";
import { ANTHROPIC_MODELS } from "./anthropic/models.ts";
import type {
  CatalogAuth,
  ProviderModelCatalogEntry,
  ProviderModelLimits,
  ProviderModelPricing,
} from "./catalog-types.ts";
import { CUSTOM_MODELS } from "./custom/models.ts";
import { GROK_MODELS } from "./grok/models.ts";
import { KILO_MODELS } from "./kilo/models.ts";
import { KIMI_MODELS } from "./kimi/models.ts";
import { OPENAI_MODELS } from "./openai/models.ts";

export type {
  CatalogAuth,
  ProviderModelCatalogEntry,
  ProviderModelChoice,
  ProviderModelLimits,
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
 *
 * Keyed by `string`, not by a union: a provider id is a validated string, so
 * every lookup here is partial and each caller below decides what an absent
 * entry means. The three answers are not the same, which is why none of them is
 * a shared default.
 */
export const PROVIDER_MODEL_CATALOG: Readonly<Record<string, ProviderModelCatalogEntry>> = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  kimi: KIMI_MODELS,
  kilo: KILO_MODELS,
  grok: GROK_MODELS,
  custom: CUSTOM_MODELS,
};

/**
 * Every way in the catalog can describe.
 *
 * This is what an *unknown* provider reaches with — see `catalogModelAuths`.
 */
const EVERY_AUTH: readonly CatalogAuth[] = ["oauth", "apiKey"];

/** The catalog's price for one provider model, or null if it is not listed. */
export function catalogPricing(provider: ProviderId, model: string): ProviderModelPricing | null {
  return (
    PROVIDER_MODEL_CATALOG[provider]?.models.find((entry) => entry.id === model)?.pricing ?? null
  );
}

/**
 * Which credential types can reach one provider model.
 *
 * The *fact*, not the rule: this says what the catalog knows, and callers
 * decide what to do about it. The rule that refuses an unreachable target lives
 * in `@omni/control`, because whether a way in exists is installation state,
 * not catalog state.
 *
 * Two answers collapse to "the provider's whole set". A choice with no `auth`
 * is served either way, which is the normal case. A model the catalog does not
 * list at all is *unknown*, never *forbidden* — the curated list is a subset of
 * what a provider serves and an operator reaches the rest by typing an id, so
 * reading an absent entry as a restriction would lock them out of most of
 * Kilo's several hundred models.
 *
 * A provider the catalog does not list at all collapses the same way, and for
 * the same reason rather than for convenience: a plugin provider ships no entry
 * here, so an empty answer would read as "no credential can reach this" and
 * `putModel` would refuse every target naming it. Unknown is not forbidden at
 * the model level and cannot be at the provider level either — the check that
 * consumes this is a ceiling on what the *catalog* claims, and it claims
 * nothing about a provider it has never heard of.
 */
export function catalogModelAuths(provider: ProviderId, model: string): readonly CatalogAuth[] {
  const entry = PROVIDER_MODEL_CATALOG[provider];
  if (entry === undefined) return EVERY_AUTH;
  return entry.models.find((choice) => choice.id === model)?.auth ?? entry.authTypes;
}

/**
 * The catalog's context and output limits for one provider model, or null if it
 * is not listed.
 *
 * How a credential authenticates is part of the question: an OAuth credential
 * for OpenAI is served by the Codex backend, whose window is a quarter of the
 * API's. A provider that answers the same either way ignores the argument.
 */
export function catalogLimits(
  provider: ProviderId,
  model: string,
  auth: CatalogAuth = "apiKey",
): ProviderModelLimits | null {
  const entry = PROVIDER_MODEL_CATALOG[provider]?.models.find((choice) => choice.id === model);
  if (entry === undefined) return null;
  return (auth === "oauth" ? entry.oauthLimits : undefined) ?? entry.limits;
}
