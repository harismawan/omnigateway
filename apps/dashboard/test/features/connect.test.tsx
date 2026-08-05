import { afterEach, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectDialog } from "../../src/features/credentials/ConnectDialog.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PKCE_START = {
  flowId: "flow-1",
  authorizeUrl: "https://claude.ai/authorize?state=abc",
  userCode: null,
  kind: "pkce" as const,
  supportsManualPaste: true,
  pollIntervalMs: 5_000,
};

const DEVICE_START = {
  flowId: "flow-2",
  authorizeUrl: "https://www.kimi.com/device",
  userCode: "WDJB-MJHT",
  kind: "device" as const,
  supportsManualPaste: false,
  pollIntervalMs: 1_000,
};

test("starting a flow posts the provider and the operator's label", async () => {
  const stub = createFetchStub({ "POST /api/connect/start": () => PKCE_START });
  renderWithProviders(
    <ConnectDialog provider="anthropic" onClose={() => {}} openWindow={() => {}} />,
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "work");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));

  await waitFor(() =>
    expect(stub.calls.some((call) => call.url === "/api/connect/start")).toBe(true),
  );
  expect(stub.calls.find((call) => call.url === "/api/connect/start")?.init?.body).toBe(
    JSON.stringify({ provider: "anthropic", label: "work" }),
  );
});

test("a pkce flow opens the authorize url and offers the paste field", async () => {
  createFetchStub({ "POST /api/connect/start": () => PKCE_START });
  const opened: string[] = [];
  renderWithProviders(
    <ConnectDialog
      provider="anthropic"
      onClose={() => {}}
      openWindow={(url) => opened.push(url)}
    />,
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "work");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));

  await waitFor(() => expect(opened).toEqual([PKCE_START.authorizeUrl]));
  expect(await screen.findByLabelText(/authorization code/i)).toBeDefined();
});

test("pasting a code posts finish with the flow id and closes on success", async () => {
  const stub = createFetchStub({
    "POST /api/connect/start": () => PKCE_START,
    "POST /api/connect/finish": () => ({ id: "cred-9" }),
  });
  let closed = false;
  renderWithProviders(
    <ConnectDialog
      provider="anthropic"
      onClose={() => {
        closed = true;
      }}
      openWindow={() => {}}
    />,
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "work");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));
  await screen.findByLabelText(/authorization code/i);
  await user.type(screen.getByLabelText(/authorization code/i), "the-auth-code");
  await user.click(screen.getByRole("button", { name: /^connect$/i }));

  await waitFor(() => expect(closed).toBe(true));
  expect(stub.calls.find((call) => call.url === "/api/connect/finish")?.init?.body).toBe(
    JSON.stringify({ flowId: "flow-1", code: "the-auth-code" }),
  );
});

test("a rejected code keeps the dialog open and shows the gateway message", async () => {
  createFetchStub({
    "POST /api/connect/start": () => PKCE_START,
    "POST /api/connect/finish": () => ({
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: "unknown or expired authorization" } },
    }),
  });
  let closed = false;
  renderWithProviders(
    <ConnectDialog
      provider="anthropic"
      onClose={() => {
        closed = true;
      }}
      openWindow={() => {}}
    />,
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "work");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));
  await screen.findByLabelText(/authorization code/i);
  await user.type(screen.getByLabelText(/authorization code/i), "bad");
  await user.click(screen.getByRole("button", { name: /^connect$/i }));

  expect(await screen.findByText(/unknown or expired authorization/i)).toBeDefined();
  expect(closed).toBe(false);
});

test("a device flow shows its user code and does not offer a paste field", async () => {
  createFetchStub({
    "POST /api/connect/start": () => DEVICE_START,
    "POST /api/connect/poll": () => ({ status: 202, body: { status: "pending" } }),
  });
  renderWithProviders(<ConnectDialog provider="kimi" onClose={() => {}} openWindow={() => {}} />);

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "kimi one");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));

  expect(await screen.findByText(DEVICE_START.userCode)).toBeDefined();
  expect(screen.queryByLabelText(/authorization code/i)).toBeNull();
  expect(screen.getByText(/waiting for approval/i)).toBeDefined();
});

test("a device flow polls until it completes and then closes", async () => {
  let polls = 0;
  createFetchStub({
    "POST /api/connect/start": () => DEVICE_START,
    "POST /api/connect/poll": () => {
      polls += 1;
      return polls < 2
        ? { status: 202, body: { status: "pending" } }
        : { status: 200, body: { status: "complete", id: "cred-7" } };
    },
  });
  let closed = false;
  renderWithProviders(
    <ConnectDialog
      provider="kimi"
      onClose={() => {
        closed = true;
      }}
      openWindow={() => {}}
    />,
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "kimi one");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));
  await screen.findByText(DEVICE_START.userCode);

  await waitFor(() => expect(closed).toBe(true), { timeout: 5_000 });
  expect(polls).toBeGreaterThanOrEqual(2);
});

test("a device error stops polling and reports why", async () => {
  createFetchStub({
    "POST /api/connect/start": () => DEVICE_START,
    "POST /api/connect/poll": () => ({
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: "the device code expired" } },
    }),
  });
  renderWithProviders(<ConnectDialog provider="kimi" onClose={() => {}} openWindow={() => {}} />);

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "kimi one");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));

  expect(await screen.findByText(/the device code expired/i)).toBeDefined();
});

test("a redirect-only pkce provider omits the paste field entirely", async () => {
  createFetchStub({
    "POST /api/connect/start": () => ({ ...PKCE_START, supportsManualPaste: false }),
    "GET /api/credentials": () => ({ credentials: [] }),
  });
  renderWithProviders(<ConnectDialog provider="openai" onClose={() => {}} openWindow={() => {}} />);

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "codex");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));

  expect(await screen.findByText(/finish signing in/i)).toBeDefined();
  expect(screen.queryByLabelText(/authorization code/i)).toBeNull();
});

test("a start failure surfaces before any window is opened", async () => {
  createFetchStub({
    "POST /api/connect/start": () => ({
      status: 400,
      body: {
        error: { code: "BAD_REQUEST", message: "provider must be one of anthropic, openai, kimi" },
      },
    }),
  });
  const opened: string[] = [];
  renderWithProviders(
    <ConnectDialog
      provider="anthropic"
      onClose={() => {}}
      openWindow={(url) => opened.push(url)}
    />,
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/label/i), "work");
  await user.click(screen.getByRole("button", { name: /start authorization/i }));

  expect(await screen.findByText(/provider must be one of/i)).toBeDefined();
  expect(opened).toEqual([]);
});
