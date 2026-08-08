import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { get } from "../api/client.ts";
import { queryKeys } from "../api/queries.ts";
import type { StatusResponse } from "../api/types.ts";
import { Rack } from "../components/Rack.tsx";
import { LiveProvider } from "../session/live.tsx";

/**
 * The gate in front of every console screen.
 *
 * `/api/status` is the one control route that answers without a session, so the
 * guard asks it before the shell renders rather than letting each panel discover
 * the expired cookie on its own.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: queryKeys.status,
      queryFn: () => get<StatusResponse>("/api/status"),
      revalidateIfStale: true,
    });

    if (!status.authenticated) {
      throw redirect({ to: "/login", search: { next: location.href } });
    }
  },
  component: () => (
    <LiveProvider>
      <Rack>
        <Outlet />
      </Rack>
    </LiveProvider>
  ),
});
