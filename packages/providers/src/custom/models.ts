import type { ProviderModelCatalogEntry } from "../catalog-types.ts";

/**
 * No catalog: the models an operator's own endpoint serves are not knowable
 * from here. It is still the one provider with no way in but a key, which is
 * exactly why `authTypes` is stated per provider and not read off `models`.
 *
 * Lives in its own file rather than inline in `catalog.ts` so every provider's
 * models are found in the same place — `<id>/models.ts` — including the one
 * whose list is empty.
 */
export const CUSTOM_MODELS = {
  defaultModel: "",
  authTypes: ["apiKey"],
  models: [],
} as const satisfies ProviderModelCatalogEntry;
