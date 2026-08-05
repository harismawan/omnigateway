import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client.ts";

type DashboardQueryClientOptions = {
  isLoginRoute?: () => boolean;
  onUnauthenticated: () => void | Promise<void>;
};

export function createDashboardQueryClient({
  isLoginRoute = () => false,
  onUnauthenticated,
}: DashboardQueryClientOptions): QueryClient {
  let handlingUnauthenticated = false;
  let queryClient: QueryClient;

  function handleError(error: unknown): void {
    if (
      !(error instanceof ApiError) ||
      !error.isUnauthenticated ||
      isLoginRoute() ||
      handlingUnauthenticated
    ) {
      return;
    }

    handlingUnauthenticated = true;
    queryClient.clear();
    void Promise.resolve(onUnauthenticated()).finally(() => {
      handlingUnauthenticated = false;
    });
  }

  queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: handleError }),
    mutationCache: new MutationCache({ onError: handleError }),
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: 1,
        refetchOnWindowFocus: true,
      },
    },
  });
  return queryClient;
}
