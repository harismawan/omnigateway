import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { get } from "../api/client.ts";
import { queryKeys } from "../api/queries.ts";
import type { StatusResponse } from "../api/types.ts";
import { Rack } from "../components/Rack.tsx";
import { StreamedLiveProvider, StreamProvider } from "../session/stream.tsx";

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
  // The socket is mounted above the LIVE switch, not beside it: the switch now
  // reads transport state, so the provider that owns the transport has to be the
  // outer one. Reversed, every board polls forever and nothing says so.
  component: () => (
    <StreamProvider>
      <StreamedLiveProvider>
        <Rack>
          <Outlet />
        </Rack>
      </StreamedLiveProvider>
    </StreamProvider>
  ),
});
