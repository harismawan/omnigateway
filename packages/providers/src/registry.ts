import type { ProviderId } from "@omni/ir";
import { anthropicDescriptor } from "./anthropic/descriptor.ts";
import { anthropicAdapter } from "./anthropic/index.ts";
import { customDescriptor } from "./custom/descriptor.ts";
import { customAdapter } from "./custom/index.ts";
import type { ProviderDescriptor, ProviderDescriptors } from "./descriptor.ts";
import { grokDescriptor } from "./grok/descriptor.ts";
import { grokAdapter } from "./grok/index.ts";
import { kiloDescriptor } from "./kilo/descriptor.ts";
import { kiloAdapter } from "./kilo/index.ts";
import { kimiDescriptor } from "./kimi/descriptor.ts";
import { kimiAdapter } from "./kimi/index.ts";
import { openaiDescriptor } from "./openai/descriptor.ts";
import { openaiAdapter } from "./openai/index.ts";
import type { ProviderAdapter } from "./types.ts";

/**
 * Every provider's data, keyed by id.
 *
 * Total rather than partial, which is what keeps the exhaustiveness the sixteen
 * separate tables used to give us: adding a member to `ProviderId` breaks this
 * one file until a descriptor exists for it.
 *
 * Free of adapter imports on purpose — see the note on `ProviderDescriptor`.
 * Anything deriving a table that adapters themselves read (`BODY_ORDER`,
 * `PROFILES`) must read this and not `PROVIDERS` below, or the import graph
 * closes on itself.
 */
export const PROVIDER_DESCRIPTORS: ProviderDescriptors = {
  anthropic: anthropicDescriptor,
  openai: openaiDescriptor,
  kimi: kimiDescriptor,
  kilo: kiloDescriptor,
  grok: grokDescriptor,
  custom: customDescriptor,
};

/** A provider's data joined to the adapter that serves it. */
export type ProviderRegistryEntry = ProviderDescriptor & { readonly adapter: ProviderAdapter };

const ADAPTER_BY_ID: Readonly<Record<ProviderId, ProviderAdapter>> = {
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
 * Built by walking `PROVIDER_DESCRIPTORS` rather than by restating the six ids a
 * third time — the whole point of this file is that the id list is written once.
 */
export const PROVIDERS: Readonly<Record<ProviderId, ProviderRegistryEntry>> = Object.fromEntries(
  Object.entries(PROVIDER_DESCRIPTORS).map(([id, descriptor]) => [
    id,
    { ...descriptor, adapter: ADAPTER_BY_ID[id as ProviderId] },
  ]),
) as Readonly<Record<ProviderId, ProviderRegistryEntry>>;

/**
 * Kept as the name dispatch and the tests already use. Derived, so it cannot
 * drift from the registry the way a second hand-written map would.
 */
export const ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = ADAPTER_BY_ID;
