import type { CatalogAuth, ProviderModelChoice } from "@omni/providers/catalog";
import { PROVIDER_MODEL_CATALOG } from "@omni/providers/catalog";
import { PROVIDER_DESCRIPTORS, PROVIDER_IDS } from "@omni/providers/descriptors";

/**
 * One provider, as the console needs to render it.
 *
 * Joins the two halves the console used to import separately — the model catalog
 * and the descriptor's presentation slice — because the console gates on a single
 * fetch and splitting them would only add a second thing to wait for.
 *
 * Assembled from the registry rather than written out, so a provider that loads
 * from `<root>/plugins/` at boot appears here the moment the registry holds one.
 * That is the property that makes this endpoint worth building before a plugin
 * exists to test it: it needs no further change when the host lands.
 */
export type CatalogProvider = {
  id: string;
  label: string;
  /** Rank in every list the console draws. Sent rather than pre-sorted. */
  order: number;
  colour: { light: string; dark: string };
  pasteHint?: string;
  callback?: { uri: string; label: string };
  defaultModel: string;
  authTypes: readonly CatalogAuth[];
  models: readonly ProviderModelChoice[];
};

/**
 * The characters a CSS colour cannot contain, because a value carrying one
 * stops being a value.
 *
 * `apps/dashboard/src/theme/GlobalStyle.ts` interpolates each hue straight into
 * a `createGlobalStyle` template, so `--p-<id>: <value>;` is string
 * concatenation and nothing between here and the stylesheet escapes anything.
 * `;` ends the declaration and `}` ends the block, so `red; } body { display:
 * none; ` writes a rule of its own; the sheet is also serialised into a
 * `<style>` element during SSR, which is what `<` and `>` are for; and a
 * backslash or a newline is how one of the others is hidden from a reader.
 *
 * Deliberately a refusal rather than an attempt to recognise a colour. The set
 * of valid colour syntaxes grows with the platform — `oklch()` is itself recent
 * — so an allowlist of colour *forms* has to be revised every time a browser
 * gains one, and the revision that lags is the one that rejects a value that
 * works. A denylist of six characters ages the other way: nothing a future CSS
 * colour needs is on it.
 */
const UNSAFE_IN_CSS_VALUE = /[;{}<>\\\n\r]/;

/**
 * A provider id that can be pasted into `--p-<id>` without escaping.
 *
 * The same expression `packages/plugin-api/src/manifest.ts` validates a plugin
 * id with, and for the same reason: a provider that arrives from a plugin is
 * named by that manifest, and the name is used to build a custom property, a
 * table name and a topic. Restated rather than imported because this is the
 * *palette's* requirement — an id that cannot be a CSS identifier cannot be
 * coloured — and the two happening to coincide today is not a reason for one to
 * silently follow the other if the manifest rule ever widens.
 */
const SAFE_PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * What a provider gets instead of a colour this endpoint refuses to serve.
 *
 * A real colour, not the empty string: `--p-<id>:` with nothing after it is a
 * parse error that takes the *rest of the block* with it in some engines, and
 * an omitted property leaves `var(--p-<id>)` resolving to nothing, which paints
 * the element colourless with no error anywhere. Neutral grey reads as "this
 * provider has no identity yet", which is the true statement.
 */
export const NEUTRAL_COLOUR = "oklch(0.62 0 0)";

/**
 * One thing this endpoint had to repair on the way out.
 *
 * Reported rather than thrown, and reported rather than dropped. A provider
 * loaded from `<root>/plugins/` supplies these values, and rule 15 is that a
 * plugin's mistakes are skipped and reported, never fatal — the console must
 * not go dark because one plugin wrote a colour wrong. Silence is the other
 * failure: a hue quietly replaced by grey looks exactly like a hue chosen grey.
 */
export type CatalogProblem = {
  /** The provider the problem is about, as the registry named it. */
  provider: string;
  field: "id" | "colour.light" | "colour.dark";
  reason: string;
};

/**
 * Whether a value may be written into `--p-<id>: …;` as-is.
 *
 * Exported because it is the contract, not an implementation detail: it is what
 * a provider author has to satisfy, and it is the only thing standing between a
 * plugin's presentation block and the console's stylesheet. Anything that
 * cannot be tested directly gets asserted through six providers that happen to
 * pass, which is a shape that keeps passing after the rule is deleted.
 */
export function isPaletteSafeColour(value: unknown): boolean {
  return safeColour(value) !== null;
}

/** Whether an id can name a custom property, a table and a topic. */
export function isPaletteSafeProviderId(id: string): boolean {
  return SAFE_PROVIDER_ID.test(id);
}

/** One half of a colour pair, read without assuming the pair exists. */
function colourHalf(colour: unknown, mode: "light" | "dark"): unknown {
  if (typeof colour !== "object" || colour === null) return undefined;
  return (colour as Record<string, unknown>)[mode];
}

/** The value if it can be written into a declaration, or null if it cannot. */
function safeColour(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || UNSAFE_IN_CSS_VALUE.test(trimmed)) return null;
  return trimmed;
}

/**
 * One provider's hue for one mode, guaranteed writable, problems reported.
 *
 * Both halves are checked independently. A provider with only its light half is
 * a real shape — it is what a plugin author who tested in one mode writes — and
 * the half that is missing is the one that gets the neutral, rather than the
 * pair being thrown away because one of them was wrong.
 */
function paletteHalf(
  id: string,
  colour: unknown,
  mode: "light" | "dark",
  report: (problem: CatalogProblem) => void,
): string {
  const value = safeColour(colourHalf(colour, mode));
  if (value !== null) return value;
  report({
    provider: id,
    field: `colour.${mode}`,
    reason: "not a CSS colour; served neutral grey instead",
  });
  return NEUTRAL_COLOUR;
}

/**
 * Every provider the gateway can serve, for the console.
 *
 * **Fields are listed, never spread.** A `...model` passthrough ships whatever
 * `ProviderModelChoice` grows next to every browser that loads the console, with
 * nothing failing — it already shipped `reasoningForm`, which the console does
 * not read and which appeared in neither the design nor the console's own mirror
 * of this type. Listing them means adding a field is a decision made here.
 *
 * Three fields the descriptor carries are deliberately absent. `tone` names a
 * terminal colour and the CLI owns the mapping from that name to an escape code.
 * `capabilities` and `writeOverInput` are router internals: shipping them to a
 * browser invites something there to depend on them, and the router's own reads
 * should stay the only ones.
 *
 * Read-only and derived — this answers what the installation *can* serve, never
 * what an operator configured. That is `listModels`, and the two must not be
 * confused: catalog pricing is a default applied when a target is created, and
 * the router prices from the saved target thereafter (boundary rule 10).
 *
 * **This is where a colour is checked, and the only place.** The console writes
 * every hue into a stylesheet by concatenation, so the value has to be safe
 * before it leaves here; a second check in the browser would be decoration,
 * since anything able to change what this function returns already serves the
 * console's own JavaScript. A provider whose id cannot name a custom property
 * is dropped outright — the id is what the colour, the picker and the palette
 * are all keyed on, so there is nothing to serve half of — and a hue that
 * cannot be written is replaced with a neutral. Both are reported through
 * `report`, which is a required parameter precisely so that a new caller has to
 * decide where the line goes rather than inherit silence.
 */
export function providerCatalog(report: (problem: CatalogProblem) => void): CatalogProvider[] {
  return PROVIDER_IDS.flatMap((id) => {
    if (!SAFE_PROVIDER_ID.test(id)) {
      report({
        // Capped: this is the one field on a `CatalogProblem` that is not
        // already known to be short, since it failed the bound that makes it so.
        provider: id.slice(0, 64),
        field: "id",
        reason: "not a usable custom-property name; provider withheld",
      });
      return [];
    }

    const descriptor = PROVIDER_DESCRIPTORS[id];
    const catalog = PROVIDER_MODEL_CATALOG[id];
    const { label, order, colour, pasteHint } = descriptor.presentation;

    return {
      id,
      label,
      order,
      colour: {
        light: paletteHalf(id, colour, "light", report),
        dark: paletteHalf(id, colour, "dark", report),
      },
      // `exactOptionalPropertyTypes` is on: an absent hint or callback is absent
      // from the payload rather than present and undefined, which is also what
      // keeps the JSON free of `null`s the console would have to narrow.
      ...(pasteHint === undefined ? {} : { pasteHint }),
      ...(descriptor.callback === undefined ? {} : { callback: descriptor.callback }),
      defaultModel: catalog.defaultModel,
      authTypes: catalog.authTypes,
      // Each model's auth is **resolved here**, never left for the console to
      // combine. `catalogModelAuths` in the provider package is the rule — a
      // model states its own set or inherits the provider's — and the console
      // had grown a second copy of that expression, thirty lines below a comment
      // saying a second copy is what put the picker and the router out of step
      // before. Sending the answer means only one of them decides.
      models: catalog.models.map((model) => ({
        id: model.id,
        label: model.label,
        pricing: model.pricing,
        limits: model.limits,
        ...(model.oauthLimits === undefined ? {} : { oauthLimits: model.oauthLimits }),
        auth: model.auth ?? catalog.authTypes,
      })),
    };
  });
}
