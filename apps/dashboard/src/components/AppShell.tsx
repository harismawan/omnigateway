import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { api } from "@/api/client.ts";
import { qk, statusQuery } from "@/api/queries.ts";
import type { OkResponse } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

export const NAV_ITEMS = [
  { to: "/credentials", label: "Credentials" },
  { to: "/models", label: "Models" },
  { to: "/usage", label: "Usage" },
  { to: "/logs", label: "Logs" },
  { to: "/keys", label: "Keys" },
] as const;

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

export function AppShell({ onSignOut, children }: { onSignOut: () => void; children: ReactNode }) {
  const queryClient = useQueryClient();

  const signOut = useMutation({
    mutationFn: () => api.post<OkResponse>("/api/logout"),
    onSettled: async () => {
      // Everything in the cache was fetched with a session that no longer
      // exists. Clearing beats invalidating: a refetch would just 401.
      queryClient.clear();
      onSignOut();
    },
  });

  return (
    <div className="flex min-h-screen">
      <nav className="w-56 shrink-0 border-r p-4">
        <p className="px-2 pb-4 text-sm font-semibold tracking-tight">OmniGateway</p>
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <Link
                to={item.to as never}
                className={cn(
                  "block rounded-md px-2 py-1.5 text-sm hover:bg-muted",
                  "aria-[current=page]:bg-muted aria-[current=page]:font-medium",
                )}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        <Button
          variant="ghost"
          size="sm"
          className="mt-6 w-full justify-start"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          Sign out
        </Button>
      </nav>
      <main className="min-w-0 flex-1 p-6">{children}</main>
    </div>
  );
}

/** Re-exported for the route file, which needs the key to clear it on sign-out. */
export const STATUS_KEY = qk.status();
