import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, redirect, useRouterState } from "@tanstack/react-router";
import {
  ChartNoAxesCombined,
  KeyRound,
  Menu,
  ScrollText,
  ShieldCheck,
  Waypoints,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { api } from "@/api/client.ts";
import { qk, statusQuery } from "@/api/queries.ts";
import type { OkResponse } from "@/api/types.ts";
import { NavDrawer, type NavItem } from "@/components/NavDrawer.tsx";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/credentials", label: "Credentials", icon: KeyRound },
  { to: "/models", label: "Models", icon: Waypoints },
  { to: "/usage", label: "Usage", icon: ChartNoAxesCombined },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/keys", label: "API keys", icon: ShieldCheck },
];

/**
 * The route guard.
 *
 * Reads `/api/status` through the shared query cache, so navigating between
 * guarded screens costs zero extra requests: `beforeLoad` and the components
 * below it hit the same entry.
 */
export async function requireSession(queryClient: QueryClient): Promise<void> {
  const status = await queryClient.ensureQueryData(statusQuery());
  if (!status.authenticated) {
    throw redirect({ to: "/login" });
  }
}

function NavLinks({
  items,
  onNavigate,
}: {
  items: readonly NavItem[];
  onNavigate?: () => void;
}): ReactElement {
  return (
    <nav aria-label="Primary">
      <ul className="space-y-1">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.to}>
              <Link
                className={cn(
                  "group relative flex min-h-11 items-center gap-3 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  "before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary before:opacity-0",
                  "aria-[current=page]:bg-primary/10 aria-[current=page]:font-medium aria-[current=page]:text-foreground aria-[current=page]:before:opacity-100",
                )}
                onClick={onNavigate}
                to={item.to as never}
              >
                <Icon aria-hidden="true" className="size-4" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function AppShell({
  onSignOut,
  children,
}: {
  onSignOut: () => void;
  children: ReactNode;
}): ReactElement {
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const currentItem = NAV_ITEMS.find((item) => item.to === pathname);

  const signOut = useMutation({
    mutationFn: () => api.post<OkResponse>("/api/logout"),
    onSettled: async () => {
      // Everything in cache was fetched with a session that no longer
      // exists. Clearing beats invalidating: a refetch would just 401.
      queryClient.clear();
      onSignOut();
    },
  });

  const handleSignOut = () => signOut.mutate();
  const renderLinks = (items: readonly NavItem[], onNavigate?: () => void) =>
    onNavigate === undefined ? (
      <NavLinks items={items} />
    ) : (
      <NavLinks items={items} onNavigate={onNavigate} />
    );

  return (
    <div className="min-h-screen bg-background text-foreground md:flex">
      <aside className="fixed inset-y-0 hidden w-60 flex-col border-r border-border bg-card md:flex">
        <div className="border-b border-border px-5 py-6">
          <p className="text-sm font-semibold tracking-tight">OmniGateway</p>
          <p className="mt-1 text-xs text-muted-foreground">Operator control plane</p>
        </div>
        <div className="flex-1 px-3 py-4">{renderLinks(NAV_ITEMS)}</div>
        <div className="border-t border-border p-3">
          <Button
            className="h-11 w-full justify-start"
            disabled={signOut.isPending}
            onClick={handleSignOut}
            variant="ghost"
          >
            Sign out
          </Button>
        </div>
      </aside>

      <DialogPrimitive.Root onOpenChange={setDrawerOpen} open={drawerOpen}>
        <div className="min-w-0 flex-1 md:ml-60">
          <header className="sticky top-0 z-30 flex min-h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur md:px-6">
            <DialogPrimitive.Trigger asChild>
              <Button
                aria-label="Open navigation"
                className="size-11 md:hidden"
                size="icon"
                type="button"
                variant="ghost"
              >
                <Menu aria-hidden="true" />
              </Button>
            </DialogPrimitive.Trigger>
            <p className="min-w-0 flex-1 truncate text-sm font-medium">
              {currentItem?.label ?? "OmniGateway"}
            </p>
            <ThemeToggle />
          </header>
          <main className="min-w-0 px-4 py-6 sm:px-6 md:px-8">{children}</main>
        </div>

        <NavDrawer
          items={NAV_ITEMS}
          onOpenChange={setDrawerOpen}
          onSignOut={handleSignOut}
          open={drawerOpen}
          renderLinks={renderLinks}
          signOutPending={signOut.isPending}
        />
      </DialogPrimitive.Root>
    </div>
  );
}

/** Re-exported for route file, which needs key to clear it on sign-out. */
export const STATUS_KEY = qk.status();
