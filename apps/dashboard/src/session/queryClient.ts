import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client.ts";

export type QueryClientOptions = {
  /** The login screen must not bounce to itself when `/api/status` says no. */
  isLoginRoute: () => boolean;
  onUnauthenticated: () => void;
};

/** As much of the router as the two handlers below actually touch. */
export type SessionRouter = {
  state: { location: { pathname: string; href: string } };
  navigate: (options: { to: "/login"; search: { next: string } }) => unknown;
};

/**
 * What an expired session does, bound to a router.
 *
 * Lives here rather than in `main.tsx` because `main.tsx` mounts the console
 * the moment it is imported and so cannot be exercised by a test — which is how
 * this navigation came to differ from the gate's own `redirect` without anything
 * noticing. Both arrive at the login screen because the session is gone, and
 * both have to carry where the operator was; one of them used to drop them on
 * the rack instead. The login screen honours only a same-origin path, so
 * `next` needs no sanitising on the way out.
 *
 * The router is passed as a thunk because it does not exist yet when the client
 * is built: the client is the router's context.
 */
export function sessionHandlers(router: () => SessionRouter): QueryClientOptions {
  return {
    isLoginRoute: () => router().state.location.pathname === "/login",
    onUnauthenticated: () =>
      void router().navigate({ to: "/login", search: { next: router().state.location.href } }),
  };
}

/**
 * One client, with a single place that reacts to an expired admin session.
 *
 * Every control route answers `AUTH` once the cookie is gone, so rather than
 * each screen handling it, the caches funnel that one code to the router.
 */
export function createDashboardQueryClient(options: QueryClientOptions): QueryClient {
  const handle = (error: unknown): void => {
    if (!(error instanceof ApiError) || !error.isUnauthenticated) return;
    if (options.isLoginRoute()) return;
    options.onUnauthenticated();
  };

  return new QueryClient({
    queryCache: new QueryCache({ onError: handle }),
    mutationCache: new MutationCache({ onError: handle }),
    defaultOptions: {
      queries: {
        // Retrying a rejected session just delays the redirect.
        retry: (failureCount, error) =>
          error instanceof ApiError && error.isUnauthenticated ? false : failureCount < 2,
        staleTime: 5_000,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}
