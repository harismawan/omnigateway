import { describe, expect, mock, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectDialog } from "../../src/features/accounts/ConnectDialog.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const pkceStart = {
  flowId: "flow-pkce",
  authorizeUrl: "https://claude.ai/oauth/authorize?state=abc",
  userCode: null,
  kind: "pkce",
  supportsManualPaste: true,
  pollIntervalMs: 5_000,
};

const deviceStart = {
  flowId: "flow-device",
  authorizeUrl: "https://www.kimi.com/device",
  userCode: "WDJB-MJHT",
  kind: "device",
  supportsManualPaste: false,
  // Short, so the test does not wait five seconds for the first poll.
  pollIntervalMs: 20,
};

function open(onConnected = mock(() => {})) {
  renderWithProviders(<ConnectDialog open onOpenChange={() => {}} onConnected={onConnected} />);
  return onConnected;
}

describe("ConnectDialog", () => {
  test("starts a flow for the chosen provider and label", async () => {
    const user = userEvent.setup();
    const stub = createFetchStub({ "POST /api/connect/start": () => pkceStart });
    open();

    await user.type(screen.getByLabelText("Label"), "work account");
    await user.click(screen.getByRole("button", { name: "Start authorization" }));

    await waitFor(() => {
      const call = stub.calls.find((entry) => entry.url === "/api/connect/start");
      expect(call?.init?.body).toBe(
        JSON.stringify({ provider: "anthropic", label: "work account" }),
      );
    });
  });

  test("falls back to the provider name when no label is given", async () => {
    const user = userEvent.setup();
    const stub = createFetchStub({ "POST /api/connect/start": () => pkceStart });
    open();

    await user.selectOptions(screen.getByLabelText("Provider"), "openai");
    await user.click(screen.getByRole("button", { name: "Start authorization" }));

    await waitFor(() => {
      const call = stub.calls.find((entry) => entry.url === "/api/connect/start");
      expect(call?.init?.body).toBe(JSON.stringify({ provider: "openai", label: "OpenAI" }));
    });
  });

  test("a PKCE flow asks for the code and finishes with it", async () => {
    const user = userEvent.setup();
    const onConnected = mock(() => {});
    const stub = createFetchStub({
      "POST /api/connect/start": () => pkceStart,
      "POST /api/connect/finish": () => ({ id: "cred-new" }),
    });
    open(onConnected);

    await user.click(screen.getByRole("button", { name: "Start authorization" }));
    const code = await screen.findByLabelText("Authorization code");
    await user.type(code, "the-code#abc");
    await user.click(screen.getByRole("button", { name: "Finish connecting" }));

    await waitFor(() => {
      const call = stub.calls.find((entry) => entry.url === "/api/connect/finish");
      expect(call?.init?.body).toBe(JSON.stringify({ flowId: "flow-pkce", code: "the-code#abc" }));
    });
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
  });

  test("OpenAI is told to paste the whole redirect URL", async () => {
    const user = userEvent.setup();
    createFetchStub({ "POST /api/connect/start": () => pkceStart });
    open();

    await user.selectOptions(screen.getByLabelText("Provider"), "openai");
    await user.click(screen.getByRole("button", { name: "Start authorization" }));

    expect(
      await screen.findByText(
        "Authorize in the browser. When it redirects to localhost, paste the whole URL.",
      ),
    ).toBeTruthy();
  });

  test("a device flow shows the code and completes without a paste", async () => {
    const user = userEvent.setup();
    const onConnected = mock(() => {});
    let polls = 0;
    createFetchStub({
      "POST /api/connect/start": () => deviceStart,
      "POST /api/connect/poll": () => {
        polls += 1;
        return polls === 1
          ? { status: 202, body: { status: "pending" } }
          : { status: "complete", id: "cred-kimi" };
      },
    });
    open(onConnected);

    await user.selectOptions(screen.getByLabelText("Provider"), "kimi");
    await user.click(screen.getByRole("button", { name: "Start authorization" }));

    expect(await screen.findByText("WDJB-MJHT")).toBeTruthy();
    expect(screen.queryByLabelText("Authorization code")).toBeNull();
    await waitFor(() => expect(onConnected).toHaveBeenCalled(), { timeout: 3_000 });
    expect(polls).toBeGreaterThan(1);
  });

  test("a rejected code is reported without losing the flow", async () => {
    const user = userEvent.setup();
    createFetchStub({
      "POST /api/connect/start": () => pkceStart,
      "POST /api/connect/finish": () => ({
        status: 400,
        body: { error: { code: "BAD_REQUEST", message: "invalid OpenAI callback URL" } },
      }),
    });
    open();

    await user.click(screen.getByRole("button", { name: "Start authorization" }));
    await user.type(await screen.findByLabelText("Authorization code"), "nonsense");
    await user.click(screen.getByRole("button", { name: "Finish connecting" }));

    expect(await screen.findByText("invalid OpenAI callback URL")).toBeTruthy();
    expect(screen.getByLabelText("Authorization code")).toBeTruthy();
  });

  test("a failed start is reported on the first step", async () => {
    const user = userEvent.setup();
    createFetchStub({
      "POST /api/connect/start": () => ({
        status: 401,
        body: { error: { code: "AUTH", message: "admin session required" } },
      }),
    });
    open();

    await user.click(screen.getByRole("button", { name: "Start authorization" }));
    expect(await screen.findByText("admin session required")).toBeTruthy();
  });

  test("the authorization link is offered for copying as well as opening", async () => {
    const user = userEvent.setup();
    createFetchStub({ "POST /api/connect/start": () => pkceStart });
    open();

    await user.click(screen.getByRole("button", { name: "Start authorization" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText(pkceStart.authorizeUrl)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Copy authorization link" })).toBeTruthy();
  });
});
