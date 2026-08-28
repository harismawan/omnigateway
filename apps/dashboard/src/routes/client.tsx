import { createFileRoute } from "@tanstack/react-router";
import { ClientShell } from "../components/ClientShell.tsx";
import { ClientBoard } from "../features/client/ClientBoard.tsx";
import { StreamedLiveProvider, StreamProvider } from "../session/stream.tsx";
import { readStatus, requireClient } from "./-gate.ts";

/**
 * The client branch: one screen, gated on a client session.
 *
 * A flat route rather than a `_client` layout with children, because there is
 * one screen. A layout would be scaffolding for pages that do not exist, and
 * the next reader would go looking for them.
 *
 * Mounted inside the same stream providers the console uses: a client holds
 * `res:usage` and `res:logs`, so the socket is what keeps this screen live and
 * the `cadence` calls inside the board have something to read.
 */
export const Route = createFileRoute("/client")({
  beforeLoad: async ({ context, location }) => {
    requireClient(await readStatus(context), location.href);
  },
  component: () => (
    <StreamProvider>
      <StreamedLiveProvider>
        <ClientShell>
          <ClientBoard />
        </ClientShell>
      </StreamedLiveProvider>
    </StreamProvider>
  ),
});
