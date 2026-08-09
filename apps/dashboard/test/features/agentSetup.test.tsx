import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentSetup } from "../../src/features/settings/AgentSetup.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const CLAUDE_FILES = [
  {
    path: "opus/settings.json",
    contents: JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: "http://localhost:9000",
          ANTHROPIC_AUTH_TOKEN: "<your OmniGateway key>",
          ANTHROPIC_MODEL: "opus",
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
        },
      },
      null,
      2,
    ),
  },
];

const OPENCODE_FILES = [
  {
    path: "opencode.json",
    contents: JSON.stringify({ provider: { omnigateway: { name: "OmniGateway" } } }, null, 2),
  },
];

function stub() {
  return createFetchStub({
    "GET /api/agent-setup": ({ url }) =>
      url.includes("client=opencode")
        ? { client: "opencode", files: OPENCODE_FILES }
        : { client: "claude", files: CLAUDE_FILES },
  });
}

describe("AgentSetup", () => {
  // The window is the entire reason this panel exists: an operator who copies a
  // block without it gets a session sized by the client's default, not by the
  // pool.
  test("shows the generated profile, window included", async () => {
    stub();
    renderWithProviders(<AgentSetup />);

    await waitFor(() => {
      expect(screen.getByText(/CLAUDE_CODE_MAX_CONTEXT_TOKENS/)).toBeTruthy();
    });
    expect(screen.getByText(/1000000/)).toBeTruthy();
    expect(screen.getByText("opus/settings.json")).toBeTruthy();
  });

  test("never renders a real key", async () => {
    stub();
    renderWithProviders(<AgentSetup />);

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

    await waitFor(() => {
      expect(screen.getByText("opus/settings.json")).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "opencode" }));

    await waitFor(() => {
      expect(screen.getByText("opencode.json")).toBeTruthy();
    });
  });

  test("says so when there is nothing to point a client at", async () => {
    createFetchStub({
      "GET /api/agent-setup": () => ({ client: "claude", files: [] }),
    });
    renderWithProviders(<AgentSetup />);

    await waitFor(() => {
      expect(screen.getByText(/No virtual models configured/)).toBeTruthy();
    });
  });
});
