import { afterEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { ApiError } from "../src/api/client.ts";
import { qk } from "../src/api/queries.ts";
import type { StatusResponse } from "../src/api/types.ts";
import { requireSession } from "../src/components/AppShell.tsx";
import { LoginScreen } from "../src/routes/login.tsx";
import { createDashboardQueryClient } from "../src/session/queryClient.ts";
import { createFetchStub } from "./helpers/fetchStub.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Ctx = { queryClient: QueryClient };

function productionLikeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5_000, retry: false },
      mutations: { retry: false },
    },
  });
}

function renderLoginHarness(configured: boolean) {
  const queryClient = productionLikeClient();
  queryClient.setQueryData<StatusResponse>(qk.status(), {
    configured,
    authenticated: false,
  });

  const rootRoute = createRootRouteWithContext<Ctx>()({ component: () => <Outlet /> });
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_app",
    beforeLoad: ({ context }) => requireSession(context.queryClient),
    component: () => <Outlet />,
  });
  const credentialsRoute = createRoute({
    getParentRoute: () => appRoute,
    path: "/credentials",
    component: () => <p>credentials screen</p>,
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: LoginRoute,
  });
  function LoginRoute() {
    const navigate = loginRoute.useNavigate();
    return <LoginScreen onAuthenticated={() => void navigate({ to: "/credentials" })} />;
  }

  const router = createRouter({
    routeTree: rootRoute.addChildren([appRoute.addChildren([credentialsRoute]), loginRoute]),
    history: createMemoryHistory({ initialEntries: ["/login"] }),
    context: { queryClient },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { queryClient, router };
}

test.each([
  { configured: true, button: /sign in/i, endpoint: "POST /api/login" },
  { configured: false, button: /create password/i, endpoint: "POST /api/setup" },
])(
  "successful $endpoint updates the cached session before guarded navigation",
  async ({ configured, button, endpoint }) => {
    const stub = createFetchStub({ [endpoint]: () => ({ ok: true }) });
    const { queryClient, router } = renderLoginHarness(configured);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText(/^password$/i), "correct-horse-battery");
    if (!configured) {
      await user.type(screen.getByLabelText(/confirm password/i), "correct-horse-battery");
    }
    await user.click(screen.getByRole("button", { name: button }));

    expect(await screen.findByText("credentials screen")).toBeDefined();
    expect(router.state.location.pathname).toBe("/credentials");
    expect(queryClient.getQueryData<StatusResponse>(qk.status())).toEqual({
      configured: true,
      authenticated: true,
    });
    expect(stub.calls.filter((call) => call.url === "/api/status")).toHaveLength(0);
  },
);

test("query 401 invokes centralized unauthenticated handling", async () => {
  let redirects = 0;
  const queryClient = createDashboardQueryClient({
    onUnauthenticated: () => {
      redirects += 1;
    },
  });
  queryClient.setQueryData(qk.credentials(), [{ id: "secret-session-data" }]);

  await expect(
    queryClient.fetchQuery({
      queryKey: ["failing-query"],
      queryFn: () => Promise.reject(new ApiError(401, "AUTH", "expired")),
    }),
  ).rejects.toBeInstanceOf(ApiError);

  await waitFor(() => expect(redirects).toBe(1));
  expect(queryClient.getQueryData(qk.credentials())).toBeUndefined();
});

test("concurrent 401 failures cause one redirect", async () => {
  let redirects = 0;
  let finishRedirect: (() => void) | undefined;
  const redirecting = new Promise<void>((resolve) => {
    finishRedirect = resolve;
  });
  const queryClient = createDashboardQueryClient({
    onUnauthenticated: () => {
      redirects += 1;
      return redirecting;
    },
  });

  const requests = ["first", "second"].map((name) =>
    queryClient
      .fetchQuery({
        queryKey: [name],
        queryFn: () => Promise.reject(new ApiError(401, "AUTH", "expired")),
      })
      .catch(() => undefined),
  );
  await Promise.all(requests);

  expect(redirects).toBe(1);
  finishRedirect?.();
});

test("401 on the login route preserves the error without redirecting or clearing status", async () => {
  let redirects = 0;
  const queryClient = createDashboardQueryClient({
    isLoginRoute: () => true,
    onUnauthenticated: () => {
      redirects += 1;
    },
  });
  const cachedStatus = { configured: true, authenticated: false };
  queryClient.setQueryData(qk.status(), cachedStatus);

  await expect(
    queryClient.fetchQuery({
      queryKey: ["login-status"],
      queryFn: () => Promise.reject(new ApiError(401, "AUTH", "expired")),
    }),
  ).rejects.toBeInstanceOf(ApiError);

  expect(redirects).toBe(0);
  expect(queryClient.getQueryData<StatusResponse>(qk.status())).toEqual(cachedStatus);
});

test("mutation 401 invokes centralized unauthenticated handling", async () => {
  let redirects = 0;
  const queryClient = createDashboardQueryClient({
    onUnauthenticated: () => {
      redirects += 1;
    },
  });
  queryClient.setQueryData(qk.models(), [{ id: "session-model" }]);
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationFn: () => Promise.reject(new ApiError(401, "AUTH", "expired")),
  });

  await expect(mutation.execute(undefined)).rejects.toBeInstanceOf(ApiError);

  await waitFor(() => expect(redirects).toBe(1));
  expect(queryClient.getQueryData(qk.models())).toBeUndefined();
});
