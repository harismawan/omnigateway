import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RouterContext } from "../../src/routes/__root.tsx";
import { Route as appRoute } from "../../src/routes/_app.tsx";
import { Route as loginRoute } from "../../src/routes/login.tsx";
import { ThemeProvider } from "../../src/theme/ThemeProvider.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";

/**
 * The gate, with a stand-in for the shell it guards.
 *
 * `beforeLoad` and `errorComponent` are the real ones — they are what is under
 * test — while the screen behind them is a word, because mounting the rack here
 * would test the rack. The client is built bare rather than through
 * `makeQueryClient`, which seeds the catalog the whole point of these tests is
 * to withhold.
 */
function renderGate() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const { beforeLoad, errorComponent } = appRoute.options;
  if (beforeLoad === undefined || errorComponent === undefined) {
    throw new Error("the shell route lost its gate or its error screen");
  }

  const rootRoute = createRootRouteWithContext<RouterContext>()({});
  // The gate hangs off the one route it guards rather than off a pathless
  // layout. A match runs its own `beforeLoad` and renders its own
  // `errorComponent` either way, and flattening it keeps the harness a router
  // rather than a second copy of the route tree.
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    beforeLoad,
    errorComponent,
    component: () => <div>the rack</div>,
  } as never);
  const { validateSearch } = loginRoute.options;
  if (validateSearch === undefined) throw new Error("the login route lost its search schema");
  const login = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    validateSearch,
    component: () => <div>the login screen</div>,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([home as never, login]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient: client },
  });

  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return router;
}

const SESSION = { configured: true, authenticated: true };

describe("the shell gate", () => {
  test("a failed catalog is an error with a retry, not a spinner", async () => {
    // The sharp edge of gating the shell: every screen now waits on provider
    // data, so a catalog the gateway cannot serve takes the whole console with
    // it. What it must never do is hang — a permanent spinner is the failure
    // this asserts against, and it looks identical to a slow gateway.
    createFetchStub({
      "GET /api/status": () => SESSION,
      "GET /api/catalog": () => ({
        status: 503,
        body: { error: { code: "INTERNAL", message: "catalog unavailable" } },
      }),
    });
    renderGate();

    expect(await screen.findByText("catalog unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("the rack")).toBeNull();
  });

  test("the retry reloads the gate rather than only clearing the message", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    createFetchStub({
      "GET /api/status": () => SESSION,
      "GET /api/catalog": () => {
        attempts += 1;
        return attempts === 1
          ? { status: 503, body: { error: { code: "INTERNAL", message: "catalog unavailable" } } }
          : { providers: [] };
      },
    });
    renderGate();

    await user.click(await screen.findByRole("button", { name: "Try again" }));

    // The shell behind it, which only renders once `beforeLoad` has resolved:
    // a retry that reset the boundary without re-running the load would leave
    // the console on the same error with nothing to show for the click.
    expect(await screen.findByText("the rack")).toBeTruthy();
    expect(attempts).toBe(2);
  });

  test("an expired session still redirects to the login screen", async () => {
    // The two failures arrive through the same channel and must not be
    // conflated: the router resolves a thrown `redirect` as a navigation, and
    // nothing in the gate may catch it on the way past and render it as an
    // error instead.
    const stub = createFetchStub({
      "GET /api/status": () => ({ configured: true, authenticated: false }),
      "GET /api/catalog": () => ({ providers: [] }),
    });
    renderGate();

    expect(await screen.findByText("the login screen")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    // `/api/catalog` is admin-gated, so the one path with no session must never
    // ask for it: sequenced after the session check, it cannot.
    await waitFor(() => expect(stub.calls.some((call) => call.url === "/api/status")).toBe(true));
    expect(stub.calls.some((call) => call.url === "/api/catalog")).toBe(false);
  });
});

/**
 * The palette mount, asserted against the source.
 *
 * A weaker instrument than rendering, and used deliberately: `AppShell` is not
 * exported and pulls `StreamProvider`, `Rack` and an `Outlet` behind it, so
 * mounting it would drag the console's whole query surface into a test about one
 * JSX line. The repository already scrapes source for a contract it cannot
 * otherwise reach — `packages/dashboard-sdk/test/theme.test.ts` reads
 * `GlobalStyle.ts` the same way.
 *
 * It earns its place because the failure it catches is silent. Deleting the
 * mount leaves every provider chip, accounts border and usage band with
 * `var(--p-<id>)` resolving to nothing: colourless, with nothing thrown and no
 * test failing. That was true of all 481 tests before this one existed.
 */
test("the shell mounts the provider palette, fed by the loaded catalog", async () => {
  const source = await Bun.file(
    new URL("../../src/routes/_app.tsx", import.meta.url).pathname,
  ).text();

  expect(source).toContain("<ProviderPalette");
  // Fed by the catalog, not an empty literal: `$providers={[]}` mounts the
  // component and defines no custom properties, which looks identical to not
  // mounting it at all.
  expect(source).toMatch(/<ProviderPalette\s+\$providers=\{catalog\}/);
});
