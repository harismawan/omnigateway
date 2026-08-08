import "@fontsource-variable/archivo/standard.css";
import "@fontsource-variable/spline-sans-mono/index.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { routeTree } from "./routeTree.gen.ts";
import { createDashboardQueryClient } from "./session/queryClient.ts";
import { ThemeProvider } from "./theme/ThemeProvider.tsx";

let router: ReturnType<typeof createRouter<typeof routeTree>>;
const queryClient = createDashboardQueryClient({
  isLoginRoute: () => router.state.location.pathname === "/login",
  onUnauthenticated: () => void router.navigate({ to: "/login" }),
});
router = createRouter({ routeTree, context: { queryClient } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("#root is missing from index.html");

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
