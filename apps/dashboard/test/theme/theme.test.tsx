import { beforeEach, describe, expect, test } from "bun:test";
import { PROVIDER_MODEL_CATALOG } from "@omni/providers/catalog";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import styled, { ServerStyleSheet } from "styled-components";
import {
  applyTheme,
  isThemeMode,
  readStoredMode,
  resolveMode,
  THEME_STORAGE_KEY,
  ThemeProvider,
  useTheme,
} from "../../src/theme/ThemeProvider.tsx";
import { PROVIDER_IDS, theme } from "../../src/theme/tokens.ts";
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
  border-left: 2px solid ${({ theme }) => theme.provider.kimi};
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

describe("provider palette", () => {
  test("the console's provider list is the catalog's, not a stale copy", () => {
    // tokens.ts hand-rolls its own list because the theme cannot import the
    // store's runtime types. Nothing makes the two agree, so a provider added
    // to the catalog and forgotten here goes uncoloured; this is that check.
    const listed: string[] = [...PROVIDER_IDS];
    expect(listed.sort()).toEqual(Object.keys(PROVIDER_MODEL_CATALOG).sort());
  });

  test("every provider has both halves of its palette", () => {
    // Collected off the server sheet rather than off the document: happy-dom
    // never reflects what `createGlobalStyle` injects, so a DOM assertion here
    // would read an empty string and pass no matter what the palette says.
    const sheet = new ServerStyleSheet();
    renderToStaticMarkup(
      sheet.collectStyles(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      ),
    );
    const css = sheet.getStyleTags();
    sheet.seal();

    for (const id of PROVIDER_IDS) {
      expect(theme.provider[id]).toBe(`var(--p-${id})`);
      // Two declarations, one per palette. A pair that only got its light half
      // repaints to nothing the moment the console is switched to dark, which
      // no light-mode test would ever notice.
      expect(css.match(new RegExp(`--p-${id}:`, "g"))).toHaveLength(2);
    }
  });
});
