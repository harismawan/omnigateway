import { afterEach, expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { ThemeToggle } from "../../src/components/ThemeToggle.tsx";
import { ThemeProvider } from "../../src/theme/ThemeProvider.tsx";
import {
  applyTheme,
  parseThemeMode,
  resolveTheme,
  THEME_STORAGE_KEY,
} from "../../src/theme/theme.ts";

type MediaQueryListener = (event: MediaQueryListEvent) => void;

let prefersDark = false;
let mediaQueryListeners = new Set<MediaQueryListener>();

function installMatchMedia(initialPrefersDark: boolean): void {
  prefersDark = initialPrefersDark;
  mediaQueryListeners = new Set<MediaQueryListener>();
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      media: query,
      get matches() {
        return prefersDark;
      },
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === "function") mediaQueryListeners.add(listener as MediaQueryListener);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === "function")
          mediaQueryListeners.delete(listener as MediaQueryListener);
      },
      addListener: (listener: MediaQueryListener) => mediaQueryListeners.add(listener),
      removeListener: (listener: MediaQueryListener) => mediaQueryListeners.delete(listener),
      dispatchEvent: () => true,
    }) as MediaQueryList;
}

function updateMediaPreference(nextPrefersDark: boolean): void {
  prefersDark = nextPrefersDark;
  const event = { matches: nextPrefersDark } as MediaQueryListEvent;
  for (const listener of mediaQueryListeners) listener(event);
}

function renderTheme(children: ReactNode = createElement(ThemeToggle)): void {
  render(createElement(ThemeProvider, null, children));
}

afterEach(() => {
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
  installMatchMedia(false);
});

test("theme toggle persists selected dark mode", async () => {
  installMatchMedia(false);
  const user = userEvent.setup();
  renderTheme();

  await user.click(screen.getByRole("button", { name: /theme: system/i }));
  await user.click(screen.getByRole("menuitemradio", { name: /dark/i }));

  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
});

test("system mode responds to media changes", async () => {
  installMatchMedia(false);
  const user = userEvent.setup();
  renderTheme();

  expect(document.documentElement.classList.contains("dark")).toBe(false);
  await act(async () => updateMediaPreference(true));
  expect(document.documentElement.classList.contains("dark")).toBe(true);

  await user.click(screen.getByRole("button", { name: /theme: system/i }));
  await user.click(screen.getByRole("menuitemradio", { name: /light/i }));
  await act(async () => updateMediaPreference(true));
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

test("invalid or absent theme preferences use system", () => {
  expect(parseThemeMode(null)).toBe("system");
  expect(parseThemeMode("sepia")).toBe("system");
});

test("system theme resolves from media preference", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
});

test("applying theme updates root without replacing unrelated classes", () => {
  document.documentElement.classList.add("test-class");
  applyTheme("dark", false);
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.classList.contains("test-class")).toBe(true);
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
});
