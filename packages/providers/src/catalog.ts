import type { ProviderId } from "@omni/ir";
import { ANTHROPIC_MODELS } from "./anthropic/models.ts";
import type {
  CatalogAuth,
  ProviderModelCatalogEntry,
  ProviderModelChoice,
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

// Nothing to inherit; see the note on `PROVIDER_DESCRIPTORS`.
Object.setPrototypeOf(PROVIDER_MODEL_CATALOG, null);

/**
 * Every way in the catalog can describe.
 *
 * This is what an *unknown* provider reaches with — see `catalogModelAuths`.
 */
const EVERY_AUTH: readonly CatalogAuth[] = ["oauth", "apiKey"];

/** The catalog's price for one provider model, or null if it is not listed. */
export function catalogPricing(provider: ProviderId, model: string): ProviderModelPricing | null {
  const entry = PROVIDER_MODEL_CATALOG[provider];
  return entry === undefined ? null : entryPricing(entry, model);
}

/**
 * The same, from a catalog entry the caller already holds.
 *
 * For a caller that has resolved a descriptor: its `catalog` is the answer, and
 * asking the id-keyed global instead reintroduces the build-time snapshot the
 * registry exists to avoid. `registerProvider` mutates `PROVIDER_DESCRIPTORS`
 * and deliberately not `PROVIDER_MODEL_CATALOG`, so a provider that arrived
 * from `<root>/plugins/` is in the first and never the second — and pricing it
 * through the second yields zero, which the scorer reads as "unpriced" and
 * `priceOf` bills as free. Silent, and exactly the shape this epic has already
 * paid for once.
 */
export function entryPricing(
  entry: ProviderModelCatalogEntry,
  model: string,
): ProviderModelPricing | null {
  return entry.models.find((choice) => choice.id === model)?.pricing ?? null;
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
  return entryModelAuths(entry, model);
}

/**
 * The same, from a catalog entry the caller already holds.
 *
 * The sibling `entryPricing` is to `catalogPricing`, and it exists for the same
 * reason: `registerProvider` mutates `PROVIDER_DESCRIPTORS` and deliberately not
 * `PROVIDER_MODEL_CATALOG`, so a provider from `<root>/plugins/` is in the first
 * and never the second. Asking the id-keyed global about one yields the
 * fail-open `EVERY_AUTH` — correct as a default, wrong as an answer when the
 * descriptor is right there saying `auth: ["oauth"]`.
 *
 * What that cost: `putModel` accepted a target whose model the operator's only
 * account cannot reach, while the console's picker — reading the same fact off
 * `/api/catalog`, which does resolve descriptors — hid it. Two surfaces
 * disagreeing about which account serves which model is the failure
 * `packages/control/src/catalog.ts` names as its reason for resolving model auth
 * server-side at all.
 */
export function entryModelAuths(
  entry: ProviderModelCatalogEntry,
  model: string,
): readonly CatalogAuth[] {
  return entry.models.find((choice) => choice.id === model)?.auth ?? entry.authTypes;
}

/**
 * What a provider the catalog cannot describe reaches with.
 *
 * Exported so a caller resolving its own descriptor answers an unknown provider
 * exactly as `catalogModelAuths` does, rather than inventing a second default —
 * `[]` there would read as "no credential can reach this" and refuse every
 * target naming a plugin provider.
 */
export const UNKNOWN_PROVIDER_AUTHS: readonly CatalogAuth[] = EVERY_AUTH;

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
  const entry = PROVIDER_MODEL_CATALOG[provider];
  return entry === undefined ? null : entryLimits(entry, model, auth);
}

/** The same, from a catalog entry the caller already holds. See `entryPricing`. */
export function entryLimits(
  entry: ProviderModelCatalogEntry,
  model: string,
  auth: CatalogAuth = "apiKey",
): ProviderModelLimits | null {
  const choice = entry.models.find((c) => c.id === model);
  return choice === undefined ? null : choiceLimits(choice, auth);
}

/**
 * The same again, from the model choice itself.
 *
 * The narrowest form, for a caller already holding the row — `omni models
 * catalog` builds its table out of choices, and computing
 * `oauthLimits ?? limits` there would be a third copy of a rule whose whole
 * point is that OpenAI's OAuth leg is served by a narrower backend. A dash in
 * that column means the two ways in agree, and a copy that drifted would print
 * the API's window for a credential that cannot reach it.
 */
export function choiceLimits(
  choice: ProviderModelChoice,
  auth: CatalogAuth = "apiKey",
): ProviderModelLimits {
  return (auth === "oauth" ? choice.oauthLimits : undefined) ?? choice.limits;
}
