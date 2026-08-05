import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  applyTheme,
  parseThemeMode,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from "./theme.ts";

type ThemeContextValue = {
  mode: ThemeMode;
  resolved: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getStoredThemeMode(): ThemeMode {
  return parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
}

function getSystemPreference(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactElement {
  const [mode, setThemeMode] = useState<ThemeMode>(getStoredThemeMode);
  const [prefersDark, setPrefersDark] = useState(getSystemPreference);
  const resolved = resolveTheme(mode, prefersDark);

  useEffect(() => {
    applyTheme(mode, prefersDark);
  }, [mode, prefersDark]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const setMode = useCallback((nextMode: ThemeMode) => {
    setThemeMode(nextMode);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
