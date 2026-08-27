import { anthropicDescriptor } from "./anthropic/descriptor.ts";
import { customDescriptor } from "./custom/descriptor.ts";
import type { ProviderDescriptors } from "./descriptor.ts";
import { grokDescriptor } from "./grok/descriptor.ts";
import { kiloDescriptor } from "./kilo/descriptor.ts";
import { kimiDescriptor } from "./kimi/descriptor.ts";
import { openaiDescriptor } from "./openai/descriptor.ts";

// Re-exported from the leaf so a reader of one descriptor need not know that the
// type lives next door — `packages/router` already imports the record from here.
export type { ProviderDescriptor, ProviderDescriptors } from "./descriptor.ts";
export { isProviderIdFormat, PROVIDER_ID_PATTERN } from "./descriptor.ts";

/**
 * Every provider's data, keyed by id.
 *
 * The six built-ins are written out here as literals. That is *not* a compile
 * error if one goes missing — the type is `Record<string, …>`, which accepts any
 * subset, so writing the ids as literals constrains nothing. Measured: deleting
 * a line here typechecks cleanly. What catches it is the unused-import lint and
 * `test/descriptor.test.ts`, whose key-set equality reads a literal list of its
 * own.
 *
 * Nor is the rest of the package derived from this: `ADAPTERS`, `PROFILES`,
 * `BODY_ORDER` and `PROVIDER_MODEL_CATALOG` are hand-written six-key literals
 * too, and only `PROVIDERS` walks. `descriptor.test.ts` is what holds all of
 * them to the same id set.
 *
 * This module is deliberately free of imports beyond the descriptor files and a
 * type, for the same reason `catalog.ts` is: `@omni/providers/descriptors` is a
 * leaf that `packages/router` and the console can read without dragging the
 * adapters and the HTTP client along. Adding a runtime import here would
 * silently undo that, and `packages/router`'s purity depends on it — the router
 * already reads `@omni/providers/catalog` on the same terms.
 *
 * Anything wanting a live adapter, a client profile or a body order reads
 * `PROVIDERS` from `registry.ts`, which joins those to these. That split is not
 * stylistic: adapters import `BODY_ORDER` and `PROFILES`, so a table carrying
 * adapters cannot sit upstream of them, and profiles read `Bun.env`, which has
 * no business in a browser bundle.
 */
export const PROVIDER_DESCRIPTORS: ProviderDescriptors = {
  anthropic: anthropicDescriptor,
  openai: openaiDescriptor,
  kimi: kimiDescriptor,
  kilo: kiloDescriptor,
  grok: grokDescriptor,
  custom: customDescriptor,
};

// Nothing to inherit, and this is load-bearing rather than tidy.
//
// A provider id arrives from a client's `model` name and from unvalidated JSON
// in `virtual_models.targets`. On an ordinary object literal
// `table["constructor"]` answers the `Object` constructor, so every
// `!== undefined` and `?.` guard in the codebase reads "that provider exists"
// and then throws on the next property access — `model: "constructor/foo"`
// reached the client as a 500 carrying an internal source expression.
//
// `noUncheckedIndexedAccess` cannot see this: it forces a guard, and the guard
// it forces is the one a prototype key defeats. Fixing each reader would leave
// the next to rediscover it, and would cover only the readers that ask an
// existence question — not `catalogPricing`'s `?.`. One invariant covers every
// reader of every provider table instead, and every such table does this.
// Pinned by `descriptor.test.ts`.
Object.setPrototypeOf(PROVIDER_DESCRIPTORS, null);

/** Every provider id, derived so the list is written once. */
export const PROVIDER_IDS = Object.keys(PROVIDER_DESCRIPTORS) as ReadonlyArray<
  keyof typeof PROVIDER_DESCRIPTORS
>;
