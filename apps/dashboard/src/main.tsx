import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { routeTree } from "./routeTree.gen.ts";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A control panel on localhost: stale data is cheap to refetch and
      // confusing to look at, so keep windows short.
      staleTime: 5_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

const router = createRouter({ routeTree, context: { queryClient } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("#root is missing from index.html");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
