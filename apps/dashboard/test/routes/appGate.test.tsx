import { describe, expect, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { ServerStyleSheet } from "styled-components";
import type { RouterContext } from "../../src/routes/__root.tsx";
import { AppShell, Route as appRoute } from "../../src/routes/_app.tsx";
import { Route as loginRoute } from "../../src/routes/login.tsx";
import { createDashboardQueryClient, sessionHandlers } from "../../src/session/queryClient.ts";
import { ThemeProvider } from "../../src/theme/ThemeProvider.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { catalogFixture } from "../helpers/fixtures.ts";
import { makeQueryClient } from "../helpers/render.tsx";

/** Where the harness starts, chosen so `next` is visibly not the default. */
const GUARDED = "/keys";

/**
 * The gate, with a stand-in for the shell it guards.
 *
 * `beforeLoad`, `pendingComponent` and `errorComponent` are the real ones —
 * they are what is under test — while the screen behind them is a word, because
 * mounting the rack here would test the rack. The catalog is deliberately *not*
 * seeded: withholding it is the whole point of these tests, so `makeQueryClient`
 * is the one helper this file cannot use.
 *
 * The client is `createDashboardQueryClient`, though, and that matters more than
 * it looks. A bare `QueryClient` has none of its wiring — no cache-level
 * `onError`, no retry rule that spares an expired session — so a catalog that
 * answers 401 rendered the error screen here while production correctly reached
 * the login screen, and this suite would have passed unchanged if that redirect
 * had broken. The one thing the harness changes is how long the client waits
 * between retries, never how many it makes or which errors it makes them for.
 */
function renderGate() {
  let router: ReturnType<typeof createRouter>;
  // Both halves of what production builds: the factory *and* the handlers it is
  // given. Restating the handlers here instead would leave the one thing they
  // decide — where an expired session lands, and whether it remembers where the
  // operator was — asserted only against this file's own copy of them.
  const client = createDashboardQueryClient(sessionHandlers(() => router as never));
  const defaults = client.getDefaultOptions();
  client.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retryDelay: 0 } });

  const { beforeLoad, errorComponent, pendingComponent, pendingMs } = appRoute.options;
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
    path: GUARDED,
    beforeLoad,
    errorComponent,
    // Forwarded only when they exist, so a route that lost either fails the one
    // test about the pending screen rather than every test in this file. Both
    // are needed for that screen to appear at all: without `pendingMs` the
    // router does not commit the match for a full second and renders nothing.
    ...(pendingComponent === undefined ? {} : { pendingComponent }),
    ...(pendingMs === undefined ? {} : { pendingMs }),
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

  router = createRouter({
    routeTree: rootRoute.addChildren([home as never, login]),
    history: createMemoryHistory({ initialEntries: [GUARDED] }),
    context: { queryClient: client },
  }) as never;

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

/**
 * Keeps `/api/catalog` unanswered until the returned function is called.
 *
 * Wrapped around the installed stub rather than built into it: a stub handler
 * returns a body, and the one thing this test needs is a request that has not
 * produced one yet. Install after `createFetchStub`, which replaces `fetch`.
 */
function holdCatalog(): () => void {
  const inner = globalThis.fetch;
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/catalog")) await held;
    return inner(input, init);
  }) as typeof globalThis.fetch;
  return release;
}

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

  test("the console is never blank while the gate is asking", async () => {
    // The state in front of the error screen, which is what an operator sees
    // for as long as the gateway takes to answer — and, on a gateway that is
    // refusing, for three attempts and their backoff. With no
    // `pendingComponent` that is an empty `<body>`: not a spinner, not a
    // message, nothing at all, and indistinguishable from a console that failed
    // to boot.
    createFetchStub({
      "GET /api/status": () => SESSION,
      "GET /api/catalog": () => ({ providers: catalogFixture() }),
    });
    // The catalog is held open rather than made slow: a timing-based version of
    // this test passes on a fast machine whatever the gate renders.
    const answered = holdCatalog();
    renderGate();

    // Promptly, not eventually. The router's own default is to keep the match
    // uncommitted — and the document empty — for a full second, so a test that
    // waited the library's default 1000ms would pass on a route that had a
    // `pendingComponent` and no `pendingMs`, which is the console as shipped.
    await waitFor(() => expect(screen.getByText("Console")).toBeTruthy(), { timeout: 600 });
    expect(screen.queryByText("the rack")).toBeNull();

    answered();
    expect(await screen.findByText("the rack")).toBeTruthy();
  });

  test("the retry reloads the gate rather than only clearing the message", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    createFetchStub({
      "GET /api/status": () => SESSION,
      // Three failures, not one: the production client retries a 503 twice, so
      // one failure never reaches the gate at all. That the fixture has to say
      // three is itself the evidence this harness runs the real retry rule.
      "GET /api/catalog": () => {
        attempts += 1;
        return attempts <= 3
          ? { status: 503, body: { error: { code: "INTERNAL", message: "catalog unavailable" } } }
          : { providers: [] };
      },
    });
    renderGate();

    await user.click(await screen.findByRole("button", { name: "Try again" }));

    // The shell behind it, which only renders once `beforeLoad` has resolved:
    // a retry that only cleared the boundary without re-running the load would
    // leave the console on the same error with nothing to show for the click.
    expect(await screen.findByText("the rack")).toBeTruthy();
    expect(attempts).toBe(4);
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
    const router = renderGate();

    expect(await screen.findByText("the login screen")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(router.state.location.search).toEqual({ next: GUARDED });

    // `/api/catalog` is admin-gated, so the one path with no session must never
    // ask for it: sequenced after the session check, it cannot.
    await waitFor(() => expect(stub.calls.some((call) => call.url === "/api/status")).toBe(true));
    expect(stub.calls.some((call) => call.url === "/api/catalog")).toBe(false);
  });

  test("a session that expires between the two calls keeps the operator's place", async () => {
    // The other way to arrive at the login screen, and the one the gate itself
    // cannot handle: `/api/status` still says yes, the cookie dies, and
    // `/api/catalog` answers `AUTH`. That rejection is caught by the query
    // client rather than by `beforeLoad`, so the navigation is
    // `onUnauthenticated`'s — and it has to carry `next` for the same reason
    // the gate's own `redirect` does, or the operator is returned to the rack
    // instead of to the screen they were reading.
    createFetchStub({
      "GET /api/status": () => SESSION,
      "GET /api/catalog": () => ({
        status: 401,
        body: { error: { code: "AUTH", message: "session expired" } },
      }),
    });
    const router = renderGate();

    expect(await screen.findByText("the login screen")).toBeTruthy();
    expect(router.state.location.search).toEqual({ next: GUARDED });
  });
});

/**
 * The palette mount, asserted by rendering the shell.
 *
 * This was a regular expression over `_app.tsx`'s source, and source-scraping
 * is satisfied by text that no longer runs: replacing `component: AppShell`
 * with an inline component that omits the palette left `AppShell` in the file,
 * dead and still matching, and so did neutering the catalog inside it. Both are
 * assertions about a string, and the thing being protected is a stylesheet.
 *
 * So there are two, and they fail for different reasons. The first says the
 * route renders *this* function; the second says this function paints the
 * catalog it was given. Neither alone is enough — the route could render a
 * correct shell that is not the one under test, or the right shell with nothing
 * in it.
 */
describe("the shell", () => {
  test("the gate renders the shell, not something that looks like it", () => {
    expect(appRoute.options.component).toBe(AppShell);
  });

  test("the shell writes every loaded provider into the palette", async () => {
    // Collected off a server sheet rather than off the document: happy-dom
    // never reflects what `createGlobalStyle` injects, so a DOM assertion here
    // would read an empty string and pass no matter what the shell mounts.
    // `test/theme/theme.test.tsx` says the same thing at the other end.
    const client = makeQueryClient();
    const rootRoute = createRootRoute();
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({ getParentRoute: () => rootRoute, path: "/", component: AppShell }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();

    const sheet = new ServerStyleSheet();
    renderToStaticMarkup(
      sheet.collectStyles(
        <ThemeProvider>
          <QueryClientProvider client={client}>
            <RouterProvider router={router as never} />
          </QueryClientProvider>
        </ThemeProvider>,
      ),
    );
    const css = sheet.getStyleTags();
    sheet.seal();

    const providers = catalogFixture();
    expect(providers.length).toBeGreaterThan(0);
    for (const { id, colour } of providers) {
      expect(css).toContain(`--p-${id}:${colour.light};`);
      expect(css).toContain(`--p-${id}:${colour.dark};`);
    }
  });
});
