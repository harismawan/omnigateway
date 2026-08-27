import type { ReactNode } from "react";
import styled from "styled-components";
import { useClientLogout } from "../api/queries.ts";
import { Button } from "../ui/Button.tsx";
import { Legend, Row, Spacer } from "../ui/primitives.ts";

/**
 * The client branch's shell.
 *
 * No rail. `Rack` exists to navigate nine console screens; a client has one, so
 * the same chrome around it would be an empty frame implying pages that are not
 * there. What it keeps is the header and the way out.
 */
const Frame = styled.div`
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100vh;
  min-height: 0;
  overflow: hidden;
`;

const Bar = styled.header`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  padding: ${({ theme }) => theme.space(2)} ${({ theme }) => theme.space(4)};
  border-bottom: 1px solid ${({ theme }) => theme.color.rule};
  background: ${({ theme }) => theme.color.panel};
`;

const Main = styled.main`
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

const Title = styled.h1`
  font-size: 15px;
  font-weight: 600;
  font-stretch: 88%;
`;

export function ClientShell({ children }: { children: ReactNode }) {
  const logout = useClientLogout();

  return (
    <Frame data-testid="client-shell">
      <Bar>
        <Legend>OmniGateway</Legend>
        <Title>Your usage</Title>
        <Spacer />
        <Row $gap={2}>
          <Button
            type="button"
            onClick={() => {
              logout.mutate(undefined, {
                // A full reload rather than a router navigation: signing out
                // must leave nothing of the previous session in memory, and the
                // gate re-runs from scratch on the way back in.
                onSuccess: () => window.location.assign("/login"),
              });
            }}
            disabled={logout.isPending}
          >
            Sign out
          </Button>
        </Row>
      </Bar>
      <Main>{children}</Main>
    </Frame>
  );
}
