import { Monitor, Moon, Sun } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import type { ReactElement } from "react";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { parseThemeMode, type ThemeMode } from "../theme/theme.ts";
import { Button } from "./ui/button.tsx";

const themeModes: readonly ThemeMode[] = ["system", "light", "dark"];

const themeIcons = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

export function ThemeToggle(): ReactElement {
  const { mode, setMode } = useTheme();
  const Icon = themeIcons[mode];

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button aria-label={`Theme: ${mode}`} size="sm" type="button" variant="ghost">
          <Icon aria-hidden="true" />
          <span className="hidden sm:inline">Theme: {mode}</span>
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Content
        align="end"
        aria-label="Theme selection"
        className="z-50 min-w-32 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        sideOffset={8}
      >
        <DropdownMenuPrimitive.RadioGroup
          onValueChange={(value) => setMode(parseThemeMode(value))}
          value={mode}
        >
          {themeModes.map((themeMode) => (
            <DropdownMenuPrimitive.RadioItem
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
              key={themeMode}
              value={themeMode}
            >
              {themeMode[0]?.toUpperCase()}
              {themeMode.slice(1)}
            </DropdownMenuPrimitive.RadioItem>
          ))}
        </DropdownMenuPrimitive.RadioGroup>
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Root>
  );
}
