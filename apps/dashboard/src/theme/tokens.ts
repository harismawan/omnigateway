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
  provider: {
    anthropic: "var(--p-anthropic)",
    openai: "var(--p-openai)",
    kimi: "var(--p-kimi)",
    kilo: "var(--p-kilo)",
    grok: "var(--p-grok)",
    custom: "var(--p-custom)",
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

/** Provider ids the gateway can hold credentials for. */
export const PROVIDER_IDS = ["anthropic", "openai", "kimi", "kilo", "grok", "custom"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  kimi: "Kimi",
  kilo: "Kilo",
  grok: "Grok",
  custom: "OpenAI Compatible",
};

export function providerColor(provider: ProviderId): string {
  return theme.provider[provider];
}
