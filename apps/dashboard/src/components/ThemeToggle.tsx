import { Monitor, Moon, Sun } from "lucide-react";
import { type ReactElement, useState } from "react";
import { useTheme } from "../theme/ThemeProvider.tsx";
import type { ThemeMode } from "../theme/theme.ts";
import { Button } from "./ui/button.tsx";

const themeModes: readonly ThemeMode[] = ["system", "light", "dark"];

const themeIcons = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

export function ThemeToggle(): ReactElement {
  const { mode, setMode } = useTheme();
  const [open, setOpen] = useState(false);
  const Icon = themeIcons[mode];

  return (
    <div className="relative">
      <Button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Theme: ${mode}`}
        onClick={() => setOpen((current) => !current)}
        size="sm"
        type="button"
        variant="ghost"
      >
        <Icon aria-hidden="true" />
        <span className="hidden sm:inline">Theme: {mode}</span>
      </Button>
      {open ? (
        <div
          aria-label="Theme selection"
          className="absolute right-0 z-50 mt-2 min-w-32 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          role="menu"
        >
          {themeModes.map((themeMode) => (
            <button
              aria-checked={mode === themeMode}
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
              key={themeMode}
              onClick={() => {
                setMode(themeMode);
                setOpen(false);
              }}
              role="menuitemradio"
              type="button"
            >
              {themeMode[0]?.toUpperCase()}
              {themeMode.slice(1)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
