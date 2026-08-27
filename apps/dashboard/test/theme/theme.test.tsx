import { beforeEach, describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import styled, { ServerStyleSheet } from "styled-components";
import type { CatalogProvider } from "../../src/api/types.ts";
import { ProviderPalette } from "../../src/theme/GlobalStyle.ts";
import {
  applyTheme,
  isThemeMode,
  readStoredMode,
  resolveMode,
  THEME_STORAGE_KEY,
  ThemeProvider,
  useTheme,
} from "../../src/theme/ThemeProvider.tsx";
import { providerColor } from "../../src/theme/tokens.ts";
import { catalogFixture } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  delete document.documentElement.dataset.theme;
});

describe("theme mode", () => {
  test("accepts only the three known modes", () => {
    expect(isThemeMode("dark")).toBe(true);
    expect(isThemeMode("system")).toBe(true);
    expect(isThemeMode("sepia")).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });

  test("an unreadable or absent preference falls back to the system", () => {
    expect(readStoredMode()).toBe("system");
    localStorage.setItem(THEME_STORAGE_KEY, "nonsense");
    expect(readStoredMode()).toBe("system");
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(readStoredMode()).toBe("dark");
  });

  test("an explicit mode resolves to itself", () => {
    expect(resolveMode("light")).toBe("light");
    expect(resolveMode("dark")).toBe("dark");
  });

  test("applying a theme writes both the class and the data attribute", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");

    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

function Switcher() {
  const { mode, resolved, setMode } = useTheme();
  return (
    <div>
      <span>
        mode:{mode} resolved:{resolved}
      </span>
      <button type="button" onClick={() => setMode("dark")}>
        go dark
      </button>
    </div>
  );
}

describe("ThemeProvider", () => {
  test("choosing a mode applies it and remembers it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Switcher />);

    await user.click(screen.getByRole("button", { name: "go dark" }));

    expect(screen.getByText(/mode:dark resolved:dark/)).toBeTruthy();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

const Probe = styled.div`
  color: ${({ theme }) => theme.color.ink};
  font-family: ${({ theme }) => theme.font.mono};
  border-left: 2px solid ${providerColor("kimi")};
`;

function Tokens() {
  const { resolved } = useTheme();
  return <span data-testid="tokens">{resolved}</span>;
}

describe("styled-components theme", () => {
  test("a styled component compiles its rules against the token theme", () => {
    const { container } = renderWithProviders(<Probe data-testid="probe" />);
    const probe = container.querySelector('[data-testid="probe"]');
    if (probe === null) throw new Error("probe did not render");

    // styled-components resolves the interpolations into one generated class
    // and injects the rule; the class landing on the node is the evidence that
    // the theme was in scope, since a missing theme throws while compiling.
    expect(probe.className.trim().length).toBeGreaterThan(0);
    const injected = [...document.querySelectorAll("style")]
      .map((node) => node.textContent ?? "")
      .join("");
    expect(injected).toContain("var(--ink)");
    expect(injected).toContain("var(--p-kimi)");
  });

  test("nesting a provider is harmless", () => {
    renderWithProviders(
      <ThemeProvider>
        <Tokens />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("tokens").textContent).toMatch(/light|dark/);
  });
});

/** The palette as it is mounted in `_app`, over whatever the catalog said. */
function paletteCss(providers: readonly CatalogProvider[]): string {
  // Collected off the server sheet rather than off the document: happy-dom
  // never reflects what `createGlobalStyle` injects, so a DOM assertion here
  // would read an empty string and pass no matter what the palette says.
  const sheet = new ServerStyleSheet();
  renderToStaticMarkup(
    sheet.collectStyles(
      <ThemeProvider>
        <ProviderPalette $providers={providers} />
        <Probe />
      </ThemeProvider>,
    ),
  );
  const css = sheet.getStyleTags();
  sheet.seal();
  return css;
}

describe("provider palette", () => {
  test("every provider in the response is coloured in both themes", () => {
    // The pair check below counts two declarations per provider without saying
    // which blocks they landed in, so two light halves would satisfy it. This
    // splits the generated sheet at `.dark` and requires the provider in each
    // side: a provider present in only one renders colourless in the other,
    // and nothing throws when it does.
    const providers = catalogFixture();
    const css = paletteCss(providers);

    const darkAt = css.indexOf(".dark{");
    expect(darkAt).toBeGreaterThan(-1);
    const light = css.slice(0, darkAt);
    const dark = css.slice(darkAt);

    for (const { id, colour } of providers) {
      // No space after the colon: stylis minifies the declaration on the way
      // through, so this is the shape it lands in, not the shape it was written
      // in.
      expect(light).toContain(`--p-${id}:${colour.light};`);
      expect(dark).toContain(`--p-${id}:${colour.dark};`);
      // Two declarations, one per palette. A pair that only got its light half
      // repaints to nothing the moment the console is switched to dark, which
      // no light-mode test would ever notice.
      expect(css.match(new RegExp(`--p-${id}:`, "g"))).toHaveLength(2);
    }
  });

  test("the name a component asks for is the name the palette writes", () => {
    // The two halves are in different files and cannot be checked against each
    // other by the compiler: `providerColor` builds a string, the palette
    // writes a declaration. `var(--p-typo)` resolves to nothing and renders
    // colourless with no error, so nothing but this would report a drift.
    for (const { id } of catalogFixture()) {
      expect(providerColor(id)).toBe(`var(--p-${id})`);
      expect(paletteCss(catalogFixture())).toContain(`${providerColor(id).slice(4, -1)}:`);
    }
  });

  test("a provider the gateway grew at boot is coloured like any other", () => {
    // The point of reading the palette over `/api/catalog`: a provider supplied
    // by a plugin exists only at runtime, so no build-time list could have
    // carried it. Nothing here knows the id.
    const css = paletteCss([
      {
        id: "plugin-provider",
        label: "Some Plugin",
        order: 9,
        colour: { light: "oklch(0.5 0.1 10)", dark: "oklch(0.7 0.1 10)" },
        defaultModel: "m",
        authTypes: ["apiKey"],
        models: [],
      },
    ]);

    expect(css).toContain("--p-plugin-provider:oklch(0.5 0.1 10);");
    expect(css).toContain("--p-plugin-provider:oklch(0.7 0.1 10);");
  });
});
