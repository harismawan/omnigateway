import type { ReactNode } from "react";
import styled from "styled-components";
import { useClientLogout, useClientLogs } from "../api/queries.ts";
import { useLive } from "../session/live.tsx";
import { Chassis } from "./ChassisBar.tsx";

/**
 * The client branch's shell.
 *
 * No rail. `Rack` exists to navigate nine console screens; a client has one, so
 * the same chrome around it would be an empty frame implying pages that are not
 * there. The top strip is the console's own `Chassis`, fed from the client's
 * scoped log tail: the pulse it draws is this key's traffic, not the gateway's,
 * which is the only tail this session is allowed to read.
 */
const Frame = styled.div`
  display: grid;
  grid-template-areas:
    "chassis"
    "main";
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  height: 100vh;
  min-height: 0;
  overflow: hidden;
`;

const Main = styled.main`
  grid-area: main;
  padding: ${({ theme }) => theme.space(4)};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space(4)};
  min-width: 0;
  min-height: 0;
  overflow-y: auto;

  @media (max-width: 720px) {
    padding: ${({ theme }) => theme.space(3)};
  }
`;

export function ClientShell({ children }: { children: ReactNode }) {
  const { cadence } = useLive();
  const logout = useClientLogout();
  // The same limit and topic the console's bar reads at, against the client's
  // own route. `res:logs` covers both query-key branches, so this pushes.
  const logs = useClientLogs(200, cadence(10_000, "res:logs"));

  return (
    <Frame data-testid="client-shell">
      <Chassis
        logs={logs.data ?? []}
        logsFailed={logs.isError}
        signOut={{
          pending: logout.isPending,
          run: () => {
            logout.mutate(undefined, {
              // A full reload rather than a router navigation: signing out
              // must leave nothing of the previous session in memory, and the
              // gate re-runs from scratch on the way back in.
              onSuccess: () => window.location.assign("/login"),
            });
          },
        }}
      />
      <Main>{children}</Main>
    </Frame>
  );
}
