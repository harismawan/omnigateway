export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "omni-theme";

export function parseThemeMode(value: string | null): ThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}

export function applyTheme(
  mode: ThemeMode,
  prefersDark: boolean,
  root: HTMLElement = document.documentElement,
): void {
  const resolved = resolveTheme(mode, prefersDark);
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
  localStorage.setItem(THEME_STORAGE_KEY, mode);
}
