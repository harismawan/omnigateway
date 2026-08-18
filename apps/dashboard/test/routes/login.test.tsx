import { describe, expect, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route as loginRoute } from "../../src/routes/login.tsx";
import { ThemeProvider } from "../../src/theme/ThemeProvider.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { makeQueryClient } from "../helpers/render.tsx";

/**
 * The login screen reads its own search params and navigates on success, so it
 * is mounted in a real memory router rather than bare.
 */
function renderLogin(initial = "/login") {
  const client = makeQueryClient();
  const rootRoute = createRootRoute();
  const { component, validateSearch } = loginRoute.options;
  if (component === undefined || validateSearch === undefined) {
    throw new Error("the login route lost its component or its search schema");
  }

  const login = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    validateSearch,
    component,
  });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div>rack</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([login, home]),
    history: createMemoryHistory({ initialEntries: [initial] }),
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

describe("login screen", () => {
  test("asks for a password on a configured gateway", async () => {
    createFetchStub({ "GET /api/status": () => ({ configured: true, authenticated: false }) });
    renderLogin();

    expect(
      await screen.findByText("This console is for the operator of this gateway."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Confirm password")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  /**
   * A restore can end the session it was started from, and an operator who is
   * suddenly at a login screen needs to know that is what happened rather than
   * that something broke.
   */
  test("says why the session ended when it was sent here with a reason", async () => {
    createFetchStub({ "GET /api/status": () => ({ configured: true, authenticated: false }) });
    renderLogin("/login?reason=admin-password-changed");

    expect(await screen.findByText(/carries a different admin password/i)).toBeTruthy();
  });

  /** A reason is a code from a closed set, never text a URL can dictate. */
  test("ignores a reason it does not recognise", async () => {
    createFetchStub({ "GET /api/status": () => ({ configured: true, authenticated: false }) });
    renderLogin("/login?reason=your%20account%20is%20suspended%2C%20call%20555");

    expect(
      await screen.findByText("This console is for the operator of this gateway."),
    ).toBeTruthy();
    expect(screen.queryByText(/suspended/i)).toBeNull();
  });

  test("a first run asks for a new password twice", async () => {
    createFetchStub({ "GET /api/status": () => ({ configured: false, authenticated: false }) });
    renderLogin();

    expect(await screen.findByText("First run")).toBeTruthy();
    expect(screen.getByLabelText("Confirm password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set password and sign in" })).toBeTruthy();
  });

  test("signing in posts the password and moves on", async () => {
    const user = userEvent.setup();
    const stub = createFetchStub({
      "GET /api/status": () => ({ configured: true, authenticated: false }),
      "POST /api/login": () => ({ ok: true }),
    });
    const router = renderLogin();

    await user.type(await screen.findByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      const call = stub.calls.find((entry) => entry.url === "/api/login");
      expect(call?.init?.body).toBe(JSON.stringify({ password: "hunter2" }));
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  test("a wrong password says what to do next and does not leak the reason", async () => {
    const user = userEvent.setup();
    createFetchStub({
      "GET /api/status": () => ({ configured: true, authenticated: false }),
      "POST /api/login": () => ({
        status: 401,
        body: { error: { code: "AUTH", message: "invalid password" } },
      }),
    });
    renderLogin();

    await user.type(await screen.findByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "That password does not match. Try again.",
    );
  });

  test("mismatched setup passwords are caught before the request", async () => {
    const user = userEvent.setup();
    const stub = createFetchStub({
      "GET /api/status": () => ({ configured: false, authenticated: false }),
    });
    renderLogin();

    await user.type(await screen.findByLabelText("Password"), "one-password");
    await user.type(screen.getByLabelText("Confirm password"), "another");
    await user.click(screen.getByRole("button", { name: "Set password and sign in" }));

    expect((await screen.findByRole("alert")).textContent).toBe("The two passwords do not match.");
    expect(stub.calls.some((call) => call.url === "/api/setup")).toBe(false);
  });

  test("a rejected setup password is reported in the gateway's words", async () => {
    const user = userEvent.setup();
    createFetchStub({
      "GET /api/status": () => ({ configured: false, authenticated: false }),
      "POST /api/setup": () => ({
        status: 400,
        body: {
          error: { code: "BAD_REQUEST", message: "password must be at least 12 characters" },
        },
      }),
    });
    renderLogin();

    await user.type(await screen.findByLabelText("Password"), "short");
    await user.type(screen.getByLabelText("Confirm password"), "short");
    await user.click(screen.getByRole("button", { name: "Set password and sign in" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "password must be at least 12 characters",
    );
  });

  test("returns to the screen the operator was sent away from", async () => {
    const user = userEvent.setup();
    createFetchStub({
      "GET /api/status": () => ({ configured: true, authenticated: false }),
      "POST /api/login": () => ({ ok: true }),
    });
    const router = renderLogin("/login?next=%2F");

    await user.type(await screen.findByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  test("an unreachable gateway is reported rather than blamed on the password", async () => {
    createFetchStub({
      "GET /api/status": () => ({
        status: 500,
        body: { error: { code: "INTERNAL", message: "internal error" } },
      }),
    });
    renderLogin();

    expect(
      await screen.findByText(
        "The gateway is not answering. Check that it is running, then reload.",
      ),
    ).toBeTruthy();
  });
});
