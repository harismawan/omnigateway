import type { ProviderCapabilities, ProviderId } from "@omni/ir";
import type { ProviderModelCatalogEntry } from "./catalog-types.ts";

/**
 * Everything core needs to know about one provider, in one record.
 *
 * The point of this type is that adding a provider stops meaning "edit sixteen
 * tables". Each field below replaces a `Record<ProviderId, …>` that used to live
 * somewhere else, and the compiler-checked exhaustiveness those tables gave us
 * is preserved here: `PROVIDER_DESCRIPTORS` is a total record, so a seventh
 * provider is a type error in exactly one place instead of eight.
 *
 * **The adapter is deliberately not on this type.** Adapters import `BODY_ORDER`
 * and `PROFILES`, and those are derived from descriptors — so a descriptor that
 * carried its own adapter would close an import cycle. `ProviderRegistryEntry`
 * in `registry.ts` is where the two are joined, and it is what anything holding
 * a live adapter should read. Keeping the data half free of adapter imports is
 * also what lets `descriptor.ts` be safe for callers that must not pull in the
 * HTTP client.
 *
 * Every field is required. There are no defaults on purpose: `writeOverInput`
 * defaulting to zero would underprice cache writes silently and permanently,
 * which is the failure mode this whole record exists to make impossible.
 */
export type ProviderDescriptor = {
  readonly id: ProviderId;

  /**
   * Canonical capabilities. Was `PROVIDER_CAPABILITIES` in
   * `packages/ir/src/capabilities.ts`.
   */
  readonly capabilities: ProviderCapabilities;

  /**
   * Whether this provider accepts Anthropic-defined tools and Anthropic-native
   * content blocks. Was `ANTHROPIC_NATIVE_TOOLS` in the same file.
   *
   * Slated for deletion: once a native block carries the provider that produced
   * it, the routing rule reads off the block and this flag has no readers. See
   * the core/provider decoupling design.
   */
  readonly anthropicNativeTools: boolean;

  /**
   * Cache-write price as a multiple of base input price, for a target that
   * names no price of its own. Was `WRITE_OVER_INPUT` in
   * `apps/gateway/src/dispatch/price.ts`.
   */
  readonly writeOverInput: { readonly fiveMinute: number; readonly oneHour: number };

  /**
   * Curated models, pricing and limits. The same value
   * `PROVIDER_MODEL_CATALOG[id]` holds.
   *
   * A reference to the provider's own `*_MODELS` list, never a copy, and never
   * the other way round: `catalog.ts` is a browser-safe leaf that assembles
   * those lists directly, and deriving it from this registry would pull the
   * adapters and the HTTP client into the dashboard bundle. Both read one
   * source; neither reads the other.
   */
  readonly catalog: ProviderModelCatalogEntry;
};

/** Total, so a new provider fails to compile until it is described. */
export type ProviderDescriptors = Readonly<Record<ProviderId, ProviderDescriptor>>;
