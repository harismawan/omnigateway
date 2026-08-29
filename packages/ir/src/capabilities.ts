/**
 * Structural shape only — `packages/providers` owns both the `Capabilities`
 * type used on `ProviderAdapter` (see `packages/providers/src/types.ts`) and the
 * per-provider values themselves (see `@omni/providers/descriptors`).
 *
 * The values used to live here, in two `Record<ProviderId, …>` tables, so that
 * `providers` (imports only `ir`) and the router (imports `ir` and `store`)
 * could both read them. They moved to the provider descriptors once
 * `@omni/providers/descriptors` existed as a leaf subpath the router can read on
 * the same terms it already reads `@omni/providers/catalog` — which is what lets
 * `ir` hold no provider-specific data at all, per architectural boundary 16.
 *
 * The type stays because the router and the store both describe a target's
 * capabilities with it and neither should have to import `providers` for a shape.
 */
export type ProviderCapabilities = { tools: boolean; images: boolean; reasoning: boolean };
