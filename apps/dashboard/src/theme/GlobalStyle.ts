import { createGlobalStyle } from "styled-components";

/** Everything the palette needs of a provider: an id and both its hues. */
export type PaletteProvider = { id: string; colour: { light: string; dark: string } };

/**
 * The `--p-<id>` half of one palette, written from the loaded catalog.
 *
 * Both modes are generated from the same list, which is what makes "a provider
 * with only one half repaints to nothing in the other theme" unrepresentable
 * rather than merely untested. The reasoning behind each hue lives in that
 * provider's `descriptor.ts`, beside the value it explains — generated CSS
 * cannot carry a comment, and a comment kept away from its value is one that
 * goes stale unnoticed.
 */
function providerPalette(providers: readonly PaletteProvider[], mode: "light" | "dark"): string {
  return providers.map(({ id, colour }) => `--p-${id}: ${colour[mode]};`).join("\n    ");
}

/**
 * The provider hues, as the custom properties `theme.provider` points at.
 *
 * Separate from `GlobalStyle` because the two have different lifetimes now that
 * the values arrive over `/api/catalog`. The chassis palette is known at module
 * scope and the login screen needs it before there is a session; these are
 * gateway state, so this is mounted inside the shell gate — `_app`'s
 * `beforeLoad` resolves the catalog before the shell renders, and the styles go
 * in during the same commit as the first provider-coloured element.
 *
 * That ordering is the point rather than an optimisation. `var(--p-unknown)`
 * resolves to nothing and renders colourless *with no error*, so a palette that
 * arrived one paint late would be a silent failure, and a permanent one if the
 * fetch had failed.
 */
export const ProviderPalette = createGlobalStyle<{ $providers: readonly PaletteProvider[] }>`
  :root {
    ${({ $providers }) => providerPalette($providers, "light")}
  }

  .dark {
    ${({ $providers }) => providerPalette($providers, "dark")}
  }
`;

/**
 * Palette values live here as custom properties rather than in the theme object
 * so that `.dark` on <html> is the single switch, applied by the pre-paint
 * script before React mounts. `theme` in tokens.ts points at these names.
 */
export const GlobalStyle = createGlobalStyle`
  :root {
    color-scheme: light;

    --rack: oklch(0.962 0.004 258);
    --panel: oklch(1 0 0);
    --panel-sunk: oklch(0.972 0.004 258);
    --panel-raised: oklch(0.988 0.003 258);
    --rule: oklch(0.9 0.006 258);
    --rule-strong: oklch(0.82 0.008 258);

    --ink: oklch(0.22 0.017 258);
    --ink-dim: oklch(0.45 0.015 258);
    --ink-faint: oklch(0.62 0.012 258);

    --accent: oklch(0.52 0.17 262);
    --accent-ink: oklch(0.99 0 0);
    --accent-wash: oklch(0.52 0.17 262 / 0.11);

    --ok: oklch(0.52 0.13 162);
    --warn: oklch(0.58 0.13 72);
    --down: oklch(0.53 0.2 27);
    --ok-wash: oklch(0.52 0.13 162 / 0.12);
    --warn-wash: oklch(0.58 0.13 72 / 0.14);
    --down-wash: oklch(0.53 0.2 27 / 0.11);

    --grid-line: oklch(0.22 0.017 258 / 0.055);
    --shadow: 0 1px 2px oklch(0.22 0.017 258 / 0.06);
  }

  .dark {
    color-scheme: dark;

    --rack: oklch(0.163 0.013 258);
    --panel: oklch(0.204 0.013 258);
    --panel-sunk: oklch(0.183 0.013 258);
    --panel-raised: oklch(0.246 0.013 258);
    --rule: oklch(0.3 0.012 258);
    --rule-strong: oklch(0.4 0.014 258);

    --ink: oklch(0.94 0.006 250);
    --ink-dim: oklch(0.72 0.011 253);
    --ink-faint: oklch(0.55 0.012 255);

    --accent: oklch(0.74 0.13 262);
    --accent-ink: oklch(0.17 0.02 262);
    --accent-wash: oklch(0.74 0.13 262 / 0.18);

    --ok: oklch(0.75 0.14 162);
    --warn: oklch(0.82 0.14 80);
    --down: oklch(0.68 0.19 25);
    --ok-wash: oklch(0.75 0.14 162 / 0.16);
    --warn-wash: oklch(0.82 0.14 80 / 0.16);
    --down-wash: oklch(0.68 0.19 25 / 0.16);

    --grid-line: oklch(0.94 0.006 250 / 0.045);
    --shadow: 0 1px 2px oklch(0 0 0 / 0.3);
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  html,
  body,
  #root {
    height: 100%;
  }

  html {
    background: ${({ theme }) => theme.color.rack};
  }

  body {
    margin: 0;
    background: ${({ theme }) => theme.color.rack};
    color: ${({ theme }) => theme.color.ink};
    font-family: ${({ theme }) => theme.font.sans};
    font-size: 14px;
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
  }

  h1, h2, h3, h4, p, figure, dl, dd {
    margin: 0;
  }

  ul, ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  button, input, select, textarea {
    font: inherit;
    color: inherit;
  }

  a {
    color: inherit;
    text-decoration: none;
  }

  :focus-visible {
    outline: 2px solid ${({ theme }) => theme.color.accent};
    outline-offset: 1px;
    border-radius: 2px;
  }

  ::selection {
    background: ${({ theme }) => theme.color.accentWash};
  }

  ::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }

  ::-webkit-scrollbar-track {
    background: transparent;
  }

  ::-webkit-scrollbar-thumb {
    background: ${({ theme }) => theme.color.ruleStrong};
    border: 3px solid transparent;
    background-clip: padding-box;
    border-radius: 6px;
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
`;
