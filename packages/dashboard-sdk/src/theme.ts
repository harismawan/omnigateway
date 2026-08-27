/**
 * The palette contract, as names rather than values.
 *
 * A plugin styles with `var(--accent)`. It does not import a token object, and
 * this file deliberately does not export one, because the custom properties in
 * `apps/dashboard/src/theme/GlobalStyle.ts` *are* the palette: they are what
 * `.dark` on `<html>` switches, in CSS, before React mounts and without
 * re-rendering anything. A JS token object handed to a plugin would be a second
 * copy of that palette which cannot switch, would have to be re-exported
 * through the federation import map to stay a single instance, and would buy a
 * plugin nothing it does not already get from the cascade for free.
 *
 * So what the SDK owes a plugin author is not the colours. It is the list of
 * names they are allowed to reach for — the ones the console guarantees are
 * defined, in both modes, and will keep defined across a minor version.
 *
 * A test reads `GlobalStyle.ts` and asserts this list matches the `:root` block
 * exactly, in both directions. Adding a palette variable to the console without
 * adding it here leaves a plugin author guessing; listing one here that the
 * console does not define hands them a `var()` that silently resolves to
 * nothing. Neither shows up in a screenshot until the wrong mode is loaded.
 */
export const CSS_VARIABLES = [
  // Chassis and panel surfaces.
  "--rack",
  "--panel",
  "--panel-sunk",
  "--panel-raised",
  "--rule",
  "--rule-strong",

  // Text, in three weights of emphasis.
  "--ink",
  "--ink-dim",
  "--ink-faint",

  // The single accent, its readable foreground, and its translucent wash.
  "--accent",
  "--accent-ink",
  "--accent-wash",

  // State. Colour in this console means provider identity or state and nothing
  // else, so a plugin reaching for one of these is making a claim about health,
  // not decorating.
  "--ok",
  "--warn",
  "--down",
  "--ok-wash",
  "--warn-wash",
  "--down-wash",

  // Provider identity. Hues are spaced so that no two providers that sit next
  // to each other in a list are neighbours on the wheel; a plugin that charts
  // per-provider data should use these rather than inventing a series palette.
  //
  // The values arrive over `/api/catalog` and are written into the document by
  // the shell, so `--p-<id>` exists for every provider the *installation*
  // serves, not only for the six a stock build compiles in. Those six are what
  // this list can promise; a plugin that wants the rest reads the catalog for
  // the ids and builds the name, exactly as the console does.
  "--p-anthropic",
  "--p-openai",
  "--p-kimi",
  "--p-kilo",
  "--p-grok",
  "--p-custom",

  // Chart furniture and elevation.
  "--grid-line",
  "--shadow",
] as const;

/** A palette variable name a plugin may use in `var(…)`. */
export type CssVariable = (typeof CSS_VARIABLES)[number];
