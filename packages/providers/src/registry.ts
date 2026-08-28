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
 * Both are read from `PROFILES` and `BODY_ORDER`, which assemble nothing beyond
 * the per-provider consts themselves — each `<id>/profile.ts` now applies its
 * own `OMNI_ORDER_*` override, so there is one answer to "what order does this
 * provider send its headers in" and every reader gets it.
 */
export type ProviderRegistryEntry = ProviderDescriptor & {
  readonly adapter: ProviderAdapter;
  readonly profile: ClientProfile;
  readonly bodyOrder: readonly string[];
};

/**
 * Kept under its original name because dispatch and the tests already inject it.
 *
 * A built-in missing from this literal is *not* a compile error — see the note
 * on `PROVIDER_DESCRIPTORS`. `descriptor.test.ts` is what catches it. The key
 * type is `string` because a provider id is one; dispatch handles a miss by
 * throwing `INTERNAL`, which is the right answer there — reaching it means the
 * router admitted a candidate it should have excluded.
 */
export const ADAPTERS: Readonly<Record<string, ProviderAdapter>> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  kimi: kimiAdapter,
  kilo: kiloAdapter,
  grok: grokAdapter,
  custom: customAdapter,
};

// Nothing to inherit; see the note on `PROVIDER_DESCRIPTORS`.
Object.setPrototypeOf(ADAPTERS, null);

/**
 * The assembled registry: descriptors plus their adapters.
 *
 * Built by walking `PROVIDER_DESCRIPTORS` rather than restating the ids a third
 * time — the point of the registry is that the list is written once.
 *
 * A descriptor whose adapter, profile or body order is missing is dropped
 * rather than joined to `undefined`. The cast this replaced asserted the join
 * was total and would have produced an entry whose `adapter` was `undefined`
 * while its type said otherwise — a lie the next reader has no way to see. The
 * key-set equality test in `descriptor.test.ts` is what turns a drop into a
 * failure; nothing in production reads this table yet, so a louder failure here
 * would only be a boot crash over a table no request touches.
 */
export const PROVIDERS: Readonly<Record<string, ProviderRegistryEntry>> = Object.fromEntries(
  Object.entries(PROVIDER_DESCRIPTORS).flatMap(([id, descriptor]) => {
    const adapter = ADAPTERS[id];
    const profile = PROFILES[id];
    const bodyOrder = BODY_ORDER[id];
    if (adapter === undefined || profile === undefined || bodyOrder === undefined) return [];
    return [[id, { ...descriptor, adapter, profile, bodyOrder }] as const];
  }),
);

// Nothing to inherit; see the note on `PROVIDER_DESCRIPTORS`. Needed here too:
// `Object.fromEntries` returns an ordinary object, so this table would carry the
// prototype keys the tables it is built from were just written to drop.
Object.setPrototypeOf(PROVIDERS, null);

/**
 * Installs a provider that was not compiled in.
 *
 * The one supported mutation of the registry, and it exists for exactly one
 * caller: boot, after `loadPlugins` and before `createApp`. Every registry read
 * in the *gateway process* is a call-time read — that was the point of widening
 * `ProviderId` — so a provider added here is visible to routing, pricing and the
 * console with no further wiring.
 *
 * **Not to the CLI.** An earlier version of this note claimed `omni doctor` too,
 * and that was wrong in a way that mattered: the CLI never calls `loadPlugins`
 * and must not, because a plugin's `setup` opens channels, runs migrations and
 * registers a provider — none of which a diagnostic should do. So `omni doctor`
 * and `omni credentials add-key` answer from the *manifest* instead, matching a
 * target's provider against installed plugins that declare the `provider`
 * capability. That is exact rather than approximate, because registration
 * requires `descriptor.id` to equal the plugin's own id.
 *
 * Adding after `createApp` would be a different thing entirely: reads happen per
 * request, so the provider would exist for later requests and not earlier ones.
 * That is a race rather than a feature, which is why this is a plain function
 * boot calls at a known point rather than a registry a plugin can write to
 * whenever it likes.
 *
 * Refuses to replace an existing id. A plugin shadowing `anthropic` would take
 * its traffic and its stored credentials, and the failure would be silent — the
 * requests keep succeeding, against the wrong upstream.
 *
 * `PROVIDERS` is deliberately not updated. It is assembled at module scope from
 * `PROFILES` and `BODY_ORDER`, which a codec-supplied provider has no entries
 * in — it carries its own header order inside its codec instead. Nothing in
 * production reads `PROVIDERS`; if that changes, this is the line that has to
 * change with it.
 */
export function registerProvider(descriptor: ProviderDescriptor, adapter: ProviderAdapter): void {
  const id = descriptor.id;
  if (Object.hasOwn(PROVIDER_DESCRIPTORS, id)) {
    throw new Error(`a provider named ${id} is already installed`);
  }
  (PROVIDER_DESCRIPTORS as Record<string, ProviderDescriptor>)[id] = descriptor;
  (ADAPTERS as Record<string, ProviderAdapter>)[id] = adapter;
}
