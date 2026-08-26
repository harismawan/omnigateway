import type { ProviderId } from "@omni/ir";
import { anthropicAdapter } from "./anthropic/index.ts";
import { customAdapter } from "./custom/index.ts";
import type { ProviderDescriptor } from "./descriptor.ts";
import { PROVIDER_DESCRIPTORS } from "./descriptors.ts";
import { grokAdapter } from "./grok/index.ts";
import { kiloAdapter } from "./kilo/index.ts";
import { kimiAdapter } from "./kimi/index.ts";
import { openaiAdapter } from "./openai/index.ts";
import type { ProviderAdapter } from "./types.ts";

/** A provider's data joined to the adapter that serves it. */
export type ProviderRegistryEntry = ProviderDescriptor & { readonly adapter: ProviderAdapter };

/**
 * Kept under its original name because dispatch and the tests already inject it.
 * Total, so a new provider fails to compile until an adapter exists for it.
 */
export const ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  kimi: kimiAdapter,
  kilo: kiloAdapter,
  grok: grokAdapter,
  custom: customAdapter,
};

/**
 * The assembled registry: descriptors plus their adapters.
 *
 * Built by walking `PROVIDER_DESCRIPTORS` rather than restating the ids a third
 * time — the point of the registry is that the list is written once.
 */
export const PROVIDERS: Readonly<Record<ProviderId, ProviderRegistryEntry>> = Object.fromEntries(
  Object.entries(PROVIDER_DESCRIPTORS).map(([id, descriptor]) => [
    id,
    { ...descriptor, adapter: ADAPTERS[id as ProviderId] },
  ]),
) as Readonly<Record<ProviderId, ProviderRegistryEntry>>;
