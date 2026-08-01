import type { ProviderId } from "./request.ts";

/**
 * Structural shape only — `packages/providers` still owns the `Capabilities`
 * type used on `ProviderAdapter` (see `packages/providers/src/types.ts`).
 * This type exists so the canonical values below have a home that both
 * `providers` (imports only `ir`) and the gateway's `router` (imports `ir`
 * and `store`, never `providers`) can legally read from.
 */
export type ProviderCapabilities = { tools: boolean; images: boolean; reasoning: boolean };

/**
 * One canonical capabilities value per provider.
 *
 * Each adapter in `packages/providers` sets its `capabilities` from this
 * table instead of restating the object literal, and the gateway router
 * reads the same table when synthesising a single-target virtual model for
 * a prefix-inferred (non-configured) model name. A provider's capabilities
 * change in exactly one place.
 */
export const PROVIDER_CAPABILITIES: Readonly<Record<ProviderId, ProviderCapabilities>> = {
  anthropic: { tools: true, images: true, reasoning: true },
  openai: { tools: true, images: true, reasoning: true },
  kimi: { tools: true, images: false, reasoning: false },
};
