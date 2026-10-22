import { createContext, useContext } from "react";

/**
 * Where a floating sheet opened from inside a modal should mount.
 *
 * A dialog locks scrolling for everything outside itself, and a popover
 * portalled to `<body>` is outside it — so a long list opened from a dialog
 * would not take the mouse wheel. `Modal` publishes its own content element
 * here, and pickers portal into it; elsewhere this is `null` and they portal to
 * `<body>` as usual.
 */
export const PopoverLayer = createContext<HTMLElement | null>(null);

export function usePopoverLayer(): HTMLElement | null {
  return useContext(PopoverLayer);
}
