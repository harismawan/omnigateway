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
import { queryKeys } from "../../src/api/queries.ts";
import {
  StreamedLiveProvider,
  StreamProvider,
  type StreamTimer,
} from "../../src/session/stream.tsx";
import { ProviderPalette } from "../../src/theme/GlobalStyle.ts";
import { ThemeProvider } from "../../src/theme/ThemeProvider.tsx";
import { catalogFixture } from "./fixtures.ts";

/**
 * A client with the provider catalog already in it.
 *
 * Seeded rather than stubbed because that is what production does: `_app`'s
 * `beforeLoad` resolves `/api/catalog` before any screen mounts, so no board
 * ever fetches it and no board test should have to route it. A test about the
 * gate itself builds its own client instead.
 *
 * `gcTime` is `Infinity` for this key alone. The suite collects unobserved
 * queries immediately, which would drop the seed in the gap between here and
 * the first component that reads it.
 */
export function makeQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  client.setQueryDefaults(queryKeys.catalog, { gcTime: Number.POSITIVE_INFINITY });
  client.setQueryData(queryKeys.catalog, catalogFixture());
  return client;
}

/**
 * How a test opts into the push socket.
 *
 * Absent means no socket, which is what every board test wants and gets for
 * free. Present means the test is about the transport and has installed
 * `installSocketStub()` — without one the constructor throws by design.
 */
export type StreamOptions = { enabled?: boolean; timer?: StreamTimer; now?: () => number };

/**
 * The shell every test renders inside.
 *
 * `StreamProvider` sits **above** `StreamedLiveProvider`, because the LIVE
 * switch now reads transport state and the provider that owns the transport has
 * to be the outer one. Reversed, `useStreamConnection` finds nothing, falls
 * through to its no-socket default, and every board polls forever — with the
 * whole suite still green. `src/session/stream.tsx` says the same thing at the
 * other end of the wire.
 *
 * The socket is **off unless a test asks for it**, and that default is doing
 * real work rather than saving a stub. Every board test in this suite therefore
 * runs with no transport at all, so the polling fallback is exercised by all
 * four hundred of them instead of by one test that remembers to check. If push
 * ever became load-bearing for a board — a panel that renders only what a frame
 * delivered — that board's existing tests would start failing here, which is
 * the point.
 */
function Providers({
  client,
  stream,
  children,
}: {
  client: QueryClient;
  stream?: StreamOptions;
  children: ReactNode;
}) {
  return (
    <ThemeProvider>
      {/* What `_app` mounts inside its gate, so a bare-rendered board has the
          same `--p-<id>` set it would have inside the shell. */}
      <ProviderPalette $providers={catalogFixture()} />
      <QueryClientProvider client={client}>
        <StreamProvider
          enabled={stream?.enabled ?? false}
          {...(stream?.timer === undefined ? {} : { timer: stream.timer })}
          {...(stream?.now === undefined ? {} : { now: stream.now })}
        >
          <StreamedLiveProvider>{children}</StreamedLiveProvider>
        </StreamProvider>
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
  options: { client?: QueryClient; stream?: StreamOptions } = {},
): RenderResult & { client: QueryClient } {
  const client = options.client ?? makeQueryClient();
  const result = render(
    <Providers
      client={client}
      {...(options.stream === undefined ? {} : { stream: options.stream })}
    >
      {ui}
    </Providers>,
  );
  return { ...result, client };
}

/** Mounts a component at `/` inside a memory router, for anything using Link. */
export function renderWithRouter(
  ui: ReactElement,
  options: { client?: QueryClient; stream?: StreamOptions } = {},
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
    <Providers
      client={client}
      {...(options.stream === undefined ? {} : { stream: options.stream })}
    >
      {/* The harness router is deliberately not the app's registered one. */}
      <RouterProvider router={router as never} />
    </Providers>,
  );
  return { ...result, client };
}
