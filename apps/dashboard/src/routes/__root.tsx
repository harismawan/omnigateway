import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import styled from "styled-components";
import { Button } from "../ui/Button.tsx";
import { Legend, Stack } from "../ui/primitives.ts";

export type RouterContext = { queryClient: QueryClient };

const Center = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: ${({ theme }) => theme.space(4)};
  text-align: center;
`;

const Message = styled.p`
  font-size: 13px;
  color: ${({ theme }) => theme.color.inkDim};
  max-width: 48ch;
`;

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: () => (
    <Center>
      <Stack $gap={3} style={{ alignItems: "center" }}>
        <Legend>Not found</Legend>
        <Message>This console has no screen at that address.</Message>
        <Button as="a" href="/" $variant="primary" $size="sm">
          Back to the rack
        </Button>
      </Stack>
    </Center>
  ),
});
