import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client.ts";

export type QueryClientOptions = {
  /** The login screen must not bounce to itself when `/api/status` says no. */
  isLoginRoute: () => boolean;
  onUnauthenticated: () => void;
};

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
