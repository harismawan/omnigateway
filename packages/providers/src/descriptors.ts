import { anthropicDescriptor } from "./anthropic/descriptor.ts";
import { customDescriptor } from "./custom/descriptor.ts";
import type { ProviderDescriptors } from "./descriptor.ts";
import { grokDescriptor } from "./grok/descriptor.ts";
import { kiloDescriptor } from "./kilo/descriptor.ts";
import { kimiDescriptor } from "./kimi/descriptor.ts";
import { openaiDescriptor } from "./openai/descriptor.ts";

/**
 * Every provider's data, keyed by id.
 *
 * Total rather than partial, which is what keeps the exhaustiveness the
 * separate `Record<ProviderId, …>` tables used to give us: adding a member to
 * `ProviderId` breaks this one file until a descriptor exists for it.
 *
 * This module is deliberately free of imports beyond the descriptor files and a
 * type, for the same reason `catalog.ts` is: `@omni/providers/descriptors` is a
 * leaf that `packages/router` and the console can read without dragging the
 * adapters and the HTTP client along. Adding a runtime import here would
 * silently undo that, and `packages/router`'s purity depends on it — the router
 * already reads `@omni/providers/catalog` on the same terms.
 *
 * Anything wanting a live adapter reads `PROVIDERS` from `registry.ts`, which
 * joins these to them. That split is not stylistic: adapters import `BODY_ORDER`
 * and `PROFILES`, so a descriptor table that carried adapters could not also be
 * what those tables derive from.
 */
export const PROVIDER_DESCRIPTORS: ProviderDescriptors = {
  anthropic: anthropicDescriptor,
  openai: openaiDescriptor,
  kimi: kimiDescriptor,
  kilo: kiloDescriptor,
  grok: grokDescriptor,
  custom: customDescriptor,
};

/** Every provider id, derived so the list is written once. */
export const PROVIDER_IDS = Object.keys(PROVIDER_DESCRIPTORS) as ReadonlyArray<
  keyof typeof PROVIDER_DESCRIPTORS
>;
