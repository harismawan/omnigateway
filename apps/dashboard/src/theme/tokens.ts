import type { ProviderId } from "@omni/ir";

/**
 * The gateway's own provider id, not a second spelling of it.
 *
 * This file used to declare its own union off a hand-written list, which meant
 * the console held two `ProviderId` types that were structurally identical
 * until the day they were not. Re-exported rather than redeclared so that
 * everything importing it from here keeps working while there stays exactly one
 * definition, in `@omni/ir`.
 */
export type { ProviderId };

/**
 * The console reads as an instrument rack: a graphite chassis, panel modules
 * with silkscreened legends, and colour that is never decorative. Hue carries
 * exactly two meanings — which provider a row belongs to, and what state
 * something is in. Everything else is ink on panel.
 *
 * Every token resolves to a CSS custom property rather than a literal, so
 * switching light/dark repaints in CSS without re-rendering the tree, and the
 * pre-paint script in index.html can set the mode before React boots.
 */
export const theme = {
  color: {
    /** Chassis behind the modules. */
    rack: "var(--rack)",
    /** A module face. */
    panel: "var(--panel)",
    /** Recessed area inside a module: table headers, code blocks. */
    panelSunk: "var(--panel-sunk)",
    /** A raised control: buttons, inputs, chips. */
    panelRaised: "var(--panel-raised)",
    rule: "var(--rule)",
    ruleStrong: "var(--rule-strong)",

    ink: "var(--ink)",
    inkDim: "var(--ink-dim)",
    inkFaint: "var(--ink-faint)",

    accent: "var(--accent)",
    accentInk: "var(--accent-ink)",
    accentWash: "var(--accent-wash)",

    ok: "var(--ok)",
    warn: "var(--warn)",
    down: "var(--down)",
    okWash: "var(--ok-wash)",
    warnWash: "var(--warn-wash)",
    downWash: "var(--down-wash)",

    shadow: "var(--shadow)",
  },
  font: {
    sans: '"Archivo Variable", ui-sans-serif, system-ui, sans-serif',
    mono: '"Spline Sans Mono Variable", ui-monospace, "SF Mono", Menlo, monospace',
  },
  radius: {
    panel: "4px",
    control: "3px",
    chip: "2px",
  },
  /** A 4px base step; the rack is laid out on it end to end. */
  space: (steps: number): string => `${steps * 4}px`,
  z: {
    rail: 20,
    chassis: 30,
    overlay: 40,
    dialog: 50,
    toast: 60,
  },
} as const;

export type AppTheme = typeof theme;

/**
 * The custom property carrying one provider's hue.
 *
 * A name, not a value: `ProviderPalette` in `GlobalStyle.ts` writes what is
 * behind it, from the catalog the shell gate has already loaded. Takes a bare
 * string rather than a `ProviderId` because a provider supplied by a plugin is
 * not in that union and is coloured the same way as any other.
 *
 * Which display name and which order go with that id are catalog questions now,
 * and answered through `useProviderCatalog()`. This file no longer holds a
 * provider list of its own — there was one, derived from a build-time registry,
 * and it could not have seen a plugin's provider at all.
 */
export const SAFE_PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;

export function providerColor(provider: string): string {
  // **Checked here, because this is where the string becomes CSS.**
  //
  // styled-components does not escape an interpolation, so this function is a
  // direct path from a stored value into the stylesheet. Its call sites hand it
  // `credential.provider`, `target.provider` and `log.resolvedProvider`, none of
  // which pass through `/api/catalog` — `packages/control` withholds a provider
  // whose id is not a usable custom-property name, and these never meet that
  // check. The count used to be written here and was wrong by the time anyone
  // read it; `providerColorOnly.test.ts` counts instead, by refusing any other
  // spelling. `providerIdSchema` guards the write path, but not the read one:
  // `sqlite/config.ts` parses `virtual_models.targets` with a bare `JSON.parse`,
  // so a restored snapshot or a hand-edited database carries whatever it says.
  // An id closing the declaration and opening its own would put
  // attacker-authored rules in the console's stylesheet.
  //
  // The pattern is restated rather than imported: boundary rule 12 forbids the
  // console importing `@omni/providers` at all, so this is the same move
  // `heldAuths` makes for the null-prototype rule. `PROVIDER_ID_PATTERN` stays
  // the source of truth and `apps/gateway/test/routes/providerIdMirror.test.ts`
  // pins this copy to it, the one place that may import both.
  if (!SAFE_PROVIDER_ID.test(provider)) return "var(--ink-faint)";
  // The fallback is not decoration either. `var(--p-x)` with no second argument
  // is invalid at computed-value time, so the property inherits — and for
  // `color` and `border-left-color` that means the provider bar becomes the
  // colour of the text beside it, which is the one element whose whole job is
  // carrying identity by hue. Reachable without any hostile input: uninstall a
  // plugin and its accounts and log rows outlive its palette entry.
  return `var(--p-${provider}, var(--ink-faint))`;
}
