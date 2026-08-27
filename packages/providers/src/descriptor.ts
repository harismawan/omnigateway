import type { ProviderCapabilities, ProviderId } from "@omni/ir";
import type { ProviderModelCatalogEntry } from "./catalog-types.ts";

/**
 * Everything core needs to know about one provider, in one record.
 *
 * The point of this type is that adding a provider stops meaning "edit sixteen
 * tables". Each field below replaces a `Record<ProviderId, …>` that used to live
 * somewhere else, and the eight scattered exhaustiveness checks those tables
 * gave us collapse into one object with one completeness check.
 *
 * That is a real trade and not a free one. `ProviderId` is a validated string,
 * so `PROVIDER_DESCRIPTORS` cannot be total in the type — see
 * `ProviderDescriptors` below for what is left of the guarantee. Every field
 * here being required is what remains of it: a descriptor is either complete or
 * it does not compile, and for a plugin it is either complete or it does not
 * register.
 *
 * **The adapter is deliberately not on this type**, and neither are `profile` or
 * `bodyOrder`. Two separate reasons, both load-bearing:
 *
 * - Adapters import `BODY_ORDER` and `PROFILES`, so a descriptor carrying its
 *   own adapter would close an import cycle.
 * - Profiles read `Bun.env`, and `descriptors.ts` is a leaf the console and the
 *   pure router bundle for the browser.
 *
 * `ProviderRegistryEntry` in `registry.ts` joins all of it. Nothing in production
 * reads that join today — dispatch takes `ADAPTERS` — so it exists for a caller
 * that wants a provider whole, and its own test is currently its only consumer.
 * Worth deleting if none appears.
 *
 * Every field is required. There are no defaults on purpose: `writeOverInput`
 * defaulting to zero would underprice cache writes silently and permanently,
 * which is the failure mode this whole record exists to make impossible.
 *
 * **One caller does it anyway, knowingly.** `apps/gateway/src/dispatch/price.ts`
 * falls back to `{ fiveMinute: 0, oneHour: 0 }` when this record has no entry
 * for a provider, because widening `ProviderId` made that lookup partial and
 * `priceOf` runs inside `finishLog`, where throwing would break usage accounting
 * for a request that already succeeded. It is unreachable today only because the
 * router excludes a provider with no descriptor and dispatch throws `INTERNAL`
 * on a missing adapter first — a coupling between three call sites, not a
 * property of that function. Recorded as a known risk in
 * `docs/superpowers/specs/2026-08-27-widening-provider-id-design.md`, to revisit
 * when the plugin host loosens it. Do not read it as licence for a second
 * default here.
 */
export type ProviderDescriptor = {
  readonly id: ProviderId;

  /**
   * Canonical capabilities. Was `PROVIDER_CAPABILITIES` in
   * `packages/ir/src/capabilities.ts`.
   */
  readonly capabilities: ProviderCapabilities;

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

  /**
   * Prefixes that infer this provider from a bare model name, so a client can
   * pass a concrete upstream model without configuring a virtual model first.
   * Was `PREFIX_PROVIDER` in `packages/router/src/resolve.ts`.
   *
   * Empty for a provider whose models are only reachable through a configured
   * target — `kilo`, which fronts other vendors' model names, and `custom`,
   * whose endpoint id a bare name cannot carry.
   */
  readonly modelPrefixes: readonly string[];

  /**
   * Where a redirect flow sends the operator's browser. Was `CALLBACKS` in
   * `packages/control/src/connect.ts`.
   *
   * Absent for every provider that hands the operator a code directly, which is
   * most of them. Nothing here binds a port: the gateway is as often as not on a
   * different machine than the browser, so the redirect is *expected* to fail to
   * connect and the operator pastes the resulting URL back.
   */
  readonly callback?: { readonly uri: string; readonly label: string };

  /**
   * How this provider is named and coloured wherever a human sees it. Was
   * `PROVIDER_LABEL` (in three separate copies), `PROVIDER_ORDER`,
   * `PROVIDER_TONE`, `theme.provider` and the `--p-<id>` custom properties.
   *
   * Presentation lives beside the rest of a provider's data rather than in the
   * console because the console was not the only place holding it, and three
   * copies of a label is how two of them come to disagree.
   */
  readonly presentation: {
    /** Display name. Not the id: `custom` shows as "OpenAI Compatible". */
    readonly label: string;
    /** Rank in every list the console and CLI draw. Lower sorts first. */
    readonly order: number;
    /** Terminal colour name. The CLI owns the mapping to an escape code. */
    readonly tone: string;
    /** `--p-<id>`, in both themes. A provider with only one renders wrong in the other. */
    readonly colour: { readonly light: string; readonly dark: string };
    /** Shown under the code box when a flow asks the operator to paste something. */
    readonly pasteHint?: string;
  };
};

/**
 * Every installed provider's descriptor, keyed by id.
 *
 * Keyed by `string`, so this is *not* total in the type. It cannot be: a
 * provider loaded from `<root>/plugins/` has an id no compiled-in union could
 * contain, and a closed key here is a closed door there.
 *
 * What survives is narrower than it first looks, so it is worth stating exactly.
 * A built-in missing from the literal in `descriptors.ts` is **not** a compile
 * error — `Record<string, …>` accepts any subset; the unused-import lint and
 * `test/descriptor.test.ts` are what catch it. Totality over a *stored* id is
 * gone outright: `Target.provider` comes back from SQLite unvalidated and can
 * name a provider this installation does not have.
 *
 * The two things the compiler still does are worth knowing precisely, because
 * they are what the rest of the design leans on. Every field below is required,
 * so a descriptor that exists but is incomplete does not compile. And
 * `noUncheckedIndexedAccess` makes every read of this record answer
 * `| undefined`, so each caller decides what absence means at the point of use
 * rather than inheriting one default.
 */
export type ProviderDescriptors = Readonly<Record<string, ProviderDescriptor>>;

/**
 * What may name a provider.
 *
 * `ProviderId` is a validated string, and this is the validation. The id is not
 * only a key: it becomes a `--p-<id>` custom property in the console's palette,
 * a `plugin_<id>_<name>` table prefix, and a `plugin:<id>:<name>` channel topic.
 * A rule that admitted anything else would push the refusal down into whichever
 * of those noticed first, which is not the same place twice.
 *
 * The same expression `packages/plugin-api/src/manifest.ts` validates a plugin
 * id with. Restated there rather than imported from here because that package is
 * published and this one is not — but this is the copy every *provider* question
 * reads, including the console palette's, which used to hold its own.
 */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Whether a string is shaped like a provider id.
 *
 * Format only. Whether the provider is *installed* is a different question with
 * a different answer per caller — `putModel` accepts a target naming one that is
 * not, for the same reason it accepts a dangling pin, while `createApiKey­Credential`
 * refuses to mint an account for a provider that does not exist.
 */
export function isProviderIdFormat(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDER_ID_PATTERN.test(value);
}
