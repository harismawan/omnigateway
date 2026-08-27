import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Rack } from "../components/Rack.tsx";
import { StreamedLiveProvider, StreamProvider } from "../session/stream.tsx";
import { readStatus, requireConsole } from "./-gate.ts";

/**
 * The gate in front of every console screen.
 *
 * Admits the operator and the read-only administrator. A client session is sent
 * to its own branch rather than to the login screen: it is authenticated, and
 * asking it to sign in again would be a lie about why it cannot be here.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    requireConsole(await readStatus(context), location.href);
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
