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
 * Whether a provider can accept Anthropic-defined tools and Anthropic-native
 * content blocks.
 *
 * Separate from the operator-editable `tools` capability on a stored target,
 * and deliberately not stored: a target either speaks Anthropic's wire format
 * or it does not, and that is decided by which adapter serves it, not by a
 * setting an operator could turn on. Keeping it here — rather than having the
 * router ask `target.provider === "anthropic"` — is what stops a provider name
 * from becoming routing logic.
 */
export const ANTHROPIC_NATIVE_TOOLS: Readonly<Record<ProviderId, boolean>> = {
  anthropic: true,
  openai: false,
  kimi: false,
  custom: false,
};

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
  custom: { tools: true, images: true, reasoning: true },
};
