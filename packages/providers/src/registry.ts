import type { ProviderId } from "@omni/ir";
import { anthropicAdapter } from "./anthropic/index.ts";
import { BODY_ORDER } from "./body.ts";
import { customAdapter } from "./custom/index.ts";
import type { ProviderDescriptor } from "./descriptor.ts";
import { PROVIDER_DESCRIPTORS } from "./descriptors.ts";
import { grokAdapter } from "./grok/index.ts";
import type { ClientProfile } from "./headers.ts";
import { kiloAdapter } from "./kilo/index.ts";
import { kimiAdapter } from "./kimi/index.ts";
import { openaiAdapter } from "./openai/index.ts";
import { PROFILES } from "./profile.ts";
import type { ProviderAdapter } from "./types.ts";

/**
 * A provider's data joined to the adapter that serves it, and to the wire
 * identity it wears.
 *
 * `profile` and `bodyOrder` are not on `ProviderDescriptor` and must not move
 * there: profiles read `Bun.env`, and `descriptors.ts` is a leaf the console
 * and the pure router bundle for the browser.
 *
 * Both are read from `PROFILES` and `BODY_ORDER` rather than from each
 * `<id>/profile.ts` directly. Those tables *are* the per-provider consts — they
 * assemble nothing else — but `PROFILES` also applies the `OMNI_ORDER_*`
 * overrides, and an entry here that skipped them would be a second answer to
 * "what order does this provider send its headers in" that disagrees with the
 * first only on installations that set the variable.
 */
export type ProviderRegistryEntry = ProviderDescriptor & {
  readonly adapter: ProviderAdapter;
  readonly profile: ClientProfile;
  readonly bodyOrder: readonly string[];
};

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
    {
      ...descriptor,
      adapter: ADAPTERS[id as ProviderId],
      profile: PROFILES[id as ProviderId],
      bodyOrder: BODY_ORDER[id as ProviderId],
    },
  ]),
) as Readonly<Record<ProviderId, ProviderRegistryEntry>>;
