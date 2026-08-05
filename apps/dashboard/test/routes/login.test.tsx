import { afterEach, expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginRoute, LoginScreen } from "../../src/routes/login.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { makeQueryClient, renderWithProviders } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("an unconfigured gateway renders the first-run setup form", async () => {
  createFetchStub({ "GET /api/status": () => ({ configured: false, authenticated: false }) });
  renderWithProviders(<LoginScreen onAuthenticated={() => {}} />);
  expect(await screen.findByRole("heading", { name: /set an admin password/i })).toBeDefined();
  expect(screen.getByLabelText(/^password$/i)).toBeDefined();
  expect(screen.getByLabelText(/confirm password/i)).toBeDefined();
});

test("a configured gateway renders the login form instead", async () => {
  createFetchStub({ "GET /api/status": () => ({ configured: true, authenticated: false }) });
  renderWithProviders(<LoginScreen onAuthenticated={() => {}} />);
  expect(await screen.findByRole("heading", { name: /sign in/i })).toBeDefined();
  expect(screen.queryByLabelText(/confirm password/i)).toBeNull();
});

test("setup posts the password and reports success upward", async () => {
  const stub = createFetchStub({
    "GET /api/status": () => ({ configured: false, authenticated: false }),
    "POST /api/setup": () => ({ ok: true }),
  });
  let authenticated = false;
  renderWithProviders(
    <LoginScreen
      onAuthenticated={() => {
        authenticated = true;
      }}
    />,
  );
  await screen.findByRole("heading", { name: /set an admin password/i });

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^password$/i), "correct-horse-battery");
  await user.type(screen.getByLabelText(/confirm password/i), "correct-horse-battery");
  await user.click(screen.getByRole("button", { name: /create password/i }));

  await waitFor(() => expect(authenticated).toBe(true));
  const setup = stub.calls.find((call) => call.url === "/api/setup");
  expect(setup?.init?.body).toBe(JSON.stringify({ password: "correct-horse-battery" }));
});

test("successful setup navigates to credentials", async () => {
  createFetchStub({
    "GET /api/status": () => ({ configured: false, authenticated: false }),
    "POST /api/setup": () => ({ ok: true }),
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: LoginRoute,
  });
  const credentialsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/credentials",
    component: () => <p>Credentials</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([loginRoute, credentialsRoute]),
    history: createMemoryHistory({ initialEntries: ["/login"] }),
  });
  renderWithProviders(<RouterProvider router={router} />, { client: makeQueryClient() });
  await screen.findByRole("heading", { name: /set an admin password/i });

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^password$/i), "correct-horse-battery");
  await user.type(screen.getByLabelText(/confirm password/i), "correct-horse-battery");
  await user.click(screen.getByRole("button", { name: /create password/i }));

  await waitFor(() => expect(router.state.location.pathname).toBe("/credentials"));
});

test("setup refuses to submit when the confirmation does not match", async () => {
  const stub = createFetchStub({
    "GET /api/status": () => ({ configured: false, authenticated: false }),
    "POST /api/setup": () => ({ ok: true }),
  });
  renderWithProviders(<LoginScreen onAuthenticated={() => {}} />);
  await screen.findByRole("heading", { name: /set an admin password/i });

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^password$/i), "correct-horse-battery");
  await user.type(screen.getByLabelText(/confirm password/i), "correct-horse-batteryy");
  await user.click(screen.getByRole("button", { name: /create password/i }));

  expect(await screen.findByText(/passwords do not match/i)).toBeDefined();
  expect(stub.calls.some((call) => call.url === "/api/setup")).toBe(false);
});

test("setup refuses a password under twelve characters without a round trip", async () => {
  const stub = createFetchStub({
    "GET /api/status": () => ({ configured: false, authenticated: false }),
    "POST /api/setup": () => ({ ok: true }),
  });
  renderWithProviders(<LoginScreen onAuthenticated={() => {}} />);
  await screen.findByRole("heading", { name: /set an admin password/i });

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^password$/i), "short");
  await user.type(screen.getByLabelText(/confirm password/i), "short");
  await user.click(screen.getByRole("button", { name: /create password/i }));

  expect(await screen.findByText(/at least 12 characters/i)).toBeDefined();
  expect(stub.calls.some((call) => call.url === "/api/setup")).toBe(false);
});

test("login posts the password and reports success upward", async () => {
  const stub = createFetchStub({
    "GET /api/status": () => ({ configured: true, authenticated: false }),
    "POST /api/login": () => ({ ok: true }),
  });
  let authenticated = false;
  renderWithProviders(
    <LoginScreen
      onAuthenticated={() => {
        authenticated = true;
      }}
    />,
  );
  await screen.findByRole("heading", { name: /sign in/i });

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^password$/i), "correct-horse-battery");
  await user.click(screen.getByRole("button", { name: /sign in/i }));

  await waitFor(() => expect(authenticated).toBe(true));
  expect(stub.calls.find((call) => call.url === "/api/login")?.init?.method).toBe("POST");
});

test("a rejected password surfaces the gateway's own message", async () => {
  createFetchStub({
    "GET /api/status": () => ({ configured: true, authenticated: false }),
    "POST /api/login": () => ({
      status: 401,
      body: { error: { code: "AUTH", message: "invalid password" } },
    }),
  });
  renderWithProviders(<LoginScreen onAuthenticated={() => {}} />);
  await screen.findByRole("heading", { name: /sign in/i });

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^password$/i), "wrong-password-here");
  await user.click(screen.getByRole("button", { name: /sign in/i }));

  expect(await screen.findByText(/invalid password/i)).toBeDefined();
});

test("a setup conflict tells the operator to sign in instead of retrying setup", async () => {
  createFetchStub({
    "GET /api/status": () => ({ configured: false, authenticated: false }),
    "POST /api/setup": () => ({
      status: 409,
      body: { error: { code: "CONFLICT", message: "an admin password is already configured" } },
    }),
  });
  renderWithProviders(<LoginScreen onAuthenticated={() => {}} />);
  await screen.findByRole("heading", { name: /set an admin password/i });

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^password$/i), "correct-horse-battery");
  await user.type(screen.getByLabelText(/confirm password/i), "correct-horse-battery");
  await user.click(screen.getByRole("button", { name: /create password/i }));

  expect(await screen.findByText(/already configured/i)).toBeDefined();
});
