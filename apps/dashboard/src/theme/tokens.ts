import type { ProviderId } from "@omni/ir";
import { PROVIDER_DESCRIPTORS, PROVIDER_IDS as REGISTERED_IDS } from "@omni/providers/descriptors";

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
 * Every provider, in the order the console draws them.
 *
 * Derived from the descriptor registry and sorted by `presentation.order`, so
 * "which providers exist" and "in what order" are answered where the providers
 * are defined. A seventh provider appears in every list here without this file
 * being touched.
 */
export const PROVIDER_IDS: readonly ProviderId[] = [...REGISTERED_IDS].sort(
  (a, b) => PROVIDER_DESCRIPTORS[a].presentation.order - PROVIDER_DESCRIPTORS[b].presentation.order,
);

/**
 * Builds a total per-provider table off the registry.
 *
 * The cast is over `Object.fromEntries`, whose return type cannot express that
 * the keys were exhaustive; the exhaustiveness itself is real and comes from
 * `PROVIDER_DESCRIPTORS` being a total record.
 */
function byProvider<T>(pick: (id: ProviderId) => T): Record<ProviderId, T> {
  return Object.fromEntries(PROVIDER_IDS.map((id) => [id, pick(id)])) as Record<ProviderId, T>;
}

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
  /**
   * One `var(--p-<id>)` per provider. The values behind those names are written
   * by `GlobalStyle.ts` from the same registry, so the two halves cannot drift.
   */
  provider: byProvider<string>((id) => `var(--p-${id})`),
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

/** Display name per provider. Not the id: `custom` shows as "OpenAI Compatible". */
export const PROVIDER_LABEL: Record<ProviderId, string> = byProvider(
  (id) => PROVIDER_DESCRIPTORS[id].presentation.label,
);

export function providerColor(provider: ProviderId): string {
  return theme.provider[provider];
}
