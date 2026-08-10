import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentSetup } from "../../src/features/settings/AgentSetup.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const CLAUDE_FILES = [
  {
    path: "settings.json",
    contents: JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: "http://localhost:9000",
          ANTHROPIC_AUTH_TOKEN: "<your OmniGateway key>",
          ANTHROPIC_MODEL: "opus",
          ANTHROPIC_DEFAULT_FABLE_MODEL: "opus",
        },
      },
      null,
      2,
    ),
  },
];

const MODELS = [
  { id: "opus", label: "Opus", strategy: "priority", targets: [] },
  { id: "haiku", label: "Haiku", strategy: "priority", targets: [] },
];

const OPENCODE_FILES = [
  {
    path: "opencode.json",
    contents: JSON.stringify({ provider: { omnigateway: { name: "OmniGateway" } } }, null, 2),
  },
];

function stub() {
  return createFetchStub({
    "GET /api/models": () => ({ models: MODELS }),
    "GET /api/agent-setup": ({ url }) =>
      url.includes("client=opencode")
        ? { client: "opencode", files: OPENCODE_FILES }
        : { client: "claude", files: CLAUDE_FILES },
  });
}

describe("AgentSetup", () => {
  test("requires a default pool and sends explicit repeated class mappings", async () => {
    const user = userEvent.setup();
    const fetch = stub();
    renderWithProviders(<AgentSetup />);

    const defaultSelect = await screen.findByRole("combobox", { name: "Default model" });
    expect(defaultSelect).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Fable model" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Opus model" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Sonnet model" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Haiku model" })).toBeTruthy();

    await user.selectOptions(defaultSelect, "opus");
    await user.selectOptions(screen.getByRole("combobox", { name: "Fable model" }), "opus");
    await user.selectOptions(screen.getByRole("combobox", { name: "Opus model" }), "opus");

    await waitFor(() => {
      expect(
        fetch.calls.some(
          (call) =>
            call.url.includes("defaultModel=opus") &&
            call.url.includes("fableModel=opus") &&
            call.url.includes("opusModel=opus"),
        ),
      ).toBe(true);
    });
    expect(screen.getByText("settings.json")).toBeTruthy();
    expect(screen.getByText(/ANTHROPIC_DEFAULT_FABLE_MODEL/)).toBeTruthy();
  });

  test("never renders a real key", async () => {
    stub();
    renderWithProviders(<AgentSetup />);

    await userEvent.selectOptions(await screen.findByLabelText("Default model"), "opus");
    await waitFor(() => {
      expect(screen.getByText(/ANTHROPIC_AUTH_TOKEN/)).toBeTruthy();
    });
    expect(screen.getByText(/<your OmniGateway key>/)).toBeTruthy();
  });

  // The suggested command has to be the one the CLI actually registers: it is
  // registered as two words, and a hyphenated `setup-claude` resolves to
  // nothing, so an operator copying this line would get "unknown command".
  test("suggests a command the CLI can resolve", async () => {
    const user = userEvent.setup();
    stub();
    renderWithProviders(<AgentSetup />);

    await waitFor(() => {
      expect(screen.getByText("omni setup claude")).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "opencode" }));

    await waitFor(() => {
      expect(screen.getByText("omni setup opencode")).toBeTruthy();
    });
  });

  test("switches to the other client's file", async () => {
    const user = userEvent.setup();
    stub();
    renderWithProviders(<AgentSetup />);

    await user.selectOptions(await screen.findByLabelText("Default model"), "opus");
    await waitFor(() => {
      expect(screen.getByText("settings.json")).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "opencode" }));

    await waitFor(() => {
      expect(screen.getByText("opencode.json")).toBeTruthy();
    });
  });

  test("says so when there is nothing to point a client at", async () => {
    createFetchStub({
      "GET /api/models": () => ({ models: [] }),
      "GET /api/agent-setup": () => ({ client: "claude", files: [] }),
    });
    renderWithProviders(<AgentSetup />);

    await waitFor(() => {
      expect(screen.getByText(/No virtual models configured/)).toBeTruthy();
    });
  });
});
