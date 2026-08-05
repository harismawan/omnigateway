import { afterEach, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell, NAV_ITEMS, requireSession } from "../../src/components/AppShell.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { makeQueryClient } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Ctx = { queryClient: QueryClient };

/**
 * A miniature router with the same guard the real `_app` layout uses. Building
 * it here rather than importing routeTree.gen.ts keeps the test independent of
 * the generated file, which does not exist until the Vite plugin has run.
 */
function harness(initial: string) {
  const queryClient = makeQueryClient();
  const rootRoute = createRootRouteWithContext<Ctx>()({ component: () => <Outlet /> });
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_app",
    beforeLoad: ({ context }) => requireSession(context.queryClient),
    component: () => (
      <AppShell onSignOut={() => {}}>
        <Outlet />
      </AppShell>
    ),
  });
  const credentialsRoute = createRoute({
    getParentRoute: () => appRoute,
    path: "/credentials",
    component: () => <p>credentials screen</p>,
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: () => <p>login screen</p>,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([appRoute.addChildren([credentialsRoute]), loginRoute]),
    history: createMemoryHistory({ initialEntries: [initial] }),
    context: { queryClient },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

test("an authenticated session renders the guarded screen", async () => {
  createFetchStub({ "GET /api/status": () => ({ configured: true, authenticated: true }) });
  harness("/credentials");
  expect(await screen.findByText("credentials screen")).toBeDefined();
});

test("an unauthenticated session redirects to login", async () => {
  createFetchStub({ "GET /api/status": () => ({ configured: true, authenticated: false }) });
  harness("/credentials");
  expect(await screen.findByText("login screen")).toBeDefined();
  expect(screen.queryByText("credentials screen")).toBeNull();
});

test("the shell links to all five screens", async () => {
  createFetchStub({ "GET /api/status": () => ({ configured: true, authenticated: true }) });
  harness("/credentials");
  await screen.findByText("credentials screen");
  for (const item of NAV_ITEMS) {
    expect(screen.getByRole("link", { name: item.label })).toBeDefined();
  }
  expect(NAV_ITEMS.map((item) => item.to)).toEqual([
    "/credentials",
    "/models",
    "/usage",
    "/logs",
    "/keys",
  ]);
});

test("signing out posts logout and clears the cached status", async () => {
  const stub = createFetchStub({
    "GET /api/status": () => ({ configured: true, authenticated: true }),
    "POST /api/logout": () => ({ ok: true }),
  });
  const { queryClient } = harness("/credentials");
  await screen.findByText("credentials screen");

  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /sign out/i }));

  await waitFor(() => expect(stub.calls.some((call) => call.url === "/api/logout")).toBe(true));
  await waitFor(() => expect(queryClient.getQueryData(["status"])).toBeUndefined());
});
