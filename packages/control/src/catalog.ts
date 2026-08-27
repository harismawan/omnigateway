import type { CatalogAuth, ProviderModelChoice } from "@omni/providers/catalog";
import { PROVIDER_MODEL_CATALOG } from "@omni/providers/catalog";
import { PROVIDER_DESCRIPTORS, PROVIDER_IDS } from "@omni/providers/descriptors";

/**
 * One provider, as the console needs to render it.
 *
 * Joins the two halves the console used to import separately — the model catalog
 * and the descriptor's presentation slice — because the console gates on a single
 * fetch and splitting them would only add a second thing to wait for.
 *
 * Assembled from the registry rather than written out, so a provider that loads
 * from `<root>/plugins/` at boot appears here the moment the registry holds one.
 * That is the property that makes this endpoint worth building before a plugin
 * exists to test it: it needs no further change when the host lands.
 */
export type CatalogProvider = {
  id: string;
  label: string;
  /** Rank in every list the console draws. Sent rather than pre-sorted. */
  order: number;
  colour: { light: string; dark: string };
  pasteHint?: string;
  callback?: { uri: string; label: string };
  defaultModel: string;
  authTypes: readonly CatalogAuth[];
  models: readonly ProviderModelChoice[];
};

/**
 * Every provider the gateway can serve, for the console.
 *
 * **Fields are listed, never spread.** A `...model` passthrough ships whatever
 * `ProviderModelChoice` grows next to every browser that loads the console, with
 * nothing failing — it already shipped `reasoningForm`, which the console does
 * not read and which appeared in neither the design nor the console's own mirror
 * of this type. Listing them means adding a field is a decision made here.
 *
 * Three fields the descriptor carries are deliberately absent. `tone` names a
 * terminal colour and the CLI owns the mapping from that name to an escape code.
 * `capabilities` and `writeOverInput` are router internals: shipping them to a
 * browser invites something there to depend on them, and the router's own reads
 * should stay the only ones.
 *
 * Read-only and derived — this answers what the installation *can* serve, never
 * what an operator configured. That is `listModels`, and the two must not be
 * confused: catalog pricing is a default applied when a target is created, and
 * the router prices from the saved target thereafter (boundary rule 10).
 */
export function providerCatalog(): CatalogProvider[] {
  return PROVIDER_IDS.map((id) => {
    const descriptor = PROVIDER_DESCRIPTORS[id];
    const catalog = PROVIDER_MODEL_CATALOG[id];
    const { label, order, colour, pasteHint } = descriptor.presentation;

    return {
      id,
      label,
      order,
      colour: { light: colour.light, dark: colour.dark },
      // `exactOptionalPropertyTypes` is on: an absent hint or callback is absent
      // from the payload rather than present and undefined, which is also what
      // keeps the JSON free of `null`s the console would have to narrow.
      ...(pasteHint === undefined ? {} : { pasteHint }),
      ...(descriptor.callback === undefined ? {} : { callback: descriptor.callback }),
      defaultModel: catalog.defaultModel,
      authTypes: catalog.authTypes,
      // Each model's auth is **resolved here**, never left for the console to
      // combine. `catalogModelAuths` in the provider package is the rule — a
      // model states its own set or inherits the provider's — and the console
      // had grown a second copy of that expression, thirty lines below a comment
      // saying a second copy is what put the picker and the router out of step
      // before. Sending the answer means only one of them decides.
      models: catalog.models.map((model) => ({
        id: model.id,
        label: model.label,
        pricing: model.pricing,
        limits: model.limits,
        ...(model.oauthLimits === undefined ? {} : { oauthLimits: model.oauthLimits }),
        auth: model.auth ?? catalog.authTypes,
      })),
    };
  });
}
