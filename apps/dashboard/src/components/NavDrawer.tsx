import type { LucideIcon } from "lucide-react";
import type { ReactElement } from "react";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { Button } from "@/components/ui/button.tsx";
import { DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
};

type NavDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly NavItem[];
  renderLinks: (items: readonly NavItem[], onNavigate: () => void) => ReactElement;
  signOutPending: boolean;
  onSignOut: () => void;
};

export function NavDrawer({
  open,
  onOpenChange,
  items,
  renderLinks,
  signOutPending,
  onSignOut,
}: NavDrawerProps): ReactElement {
  if (!open) {
    return <></>;
  }

  return (
    <DialogContent
      aria-describedby={undefined}
      className="inset-y-0 left-0 h-dvh w-[min(20rem,calc(100%-2rem))] max-w-none translate-x-0 translate-y-0 rounded-none border-y-0 border-l-0 p-0 sm:max-w-none"
      showCloseButton={false}
    >
      <div className="flex h-full flex-col">
        <div className="border-b border-border px-5 py-5">
          <DialogTitle className="text-sm font-semibold tracking-tight">OmniGateway</DialogTitle>
          <p className="mt-1 text-xs text-muted-foreground">Operator control plane</p>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          {renderLinks(items, () => onOpenChange(false))}
        </div>
        <div className="space-y-2 border-t border-border p-3">
          <ThemeToggle />
          <Button
            className="h-11 w-full justify-start"
            disabled={signOutPending}
            onClick={onSignOut}
            variant="ghost"
          >
            Sign out
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}
