import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { LiveProvider } from "../../src/session/live.tsx";
import { ThemeProvider } from "../../src/theme/ThemeProvider.tsx";

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <LiveProvider>{children}</LiveProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export function queryWrapper(client = makeQueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <Providers client={client}>{children}</Providers>;
  };
}

/**
 * Renders a feature without a router.
 *
 * Boards that navigate need `renderWithRouter`; the rest only need the query
 * and theme contexts, and mounting them bare keeps the assertions about the
 * feature rather than about routing.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: { client?: QueryClient } = {},
): RenderResult & { client: QueryClient } {
  const client = options.client ?? makeQueryClient();
  const result = render(<Providers client={client}>{ui}</Providers>);
  return { ...result, client };
}

/** Mounts a component at `/` inside a memory router, for anything using Link. */
export function renderWithRouter(
  ui: ReactElement,
  options: { client?: QueryClient } = {},
): RenderResult & { client: QueryClient } {
  const client = options.client ?? makeQueryClient();
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => ui,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  const result = render(
    <Providers client={client}>
      {/* The harness router is deliberately not the app's registered one. */}
      <RouterProvider router={router as never} />
    </Providers>,
  );
  return { ...result, client };
}
