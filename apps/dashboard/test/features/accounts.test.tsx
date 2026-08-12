import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountsBoard } from "../../src/features/accounts/AccountsBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { credential, health, NOW, quota, settings } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const credentials = [
  credential(),
  credential({ id: "cred-2", provider: "openai", label: "codex-work", enabled: false, tier: 2 }),
];

function stubAccounts(overrides: Parameters<typeof createFetchStub>[0] = {}) {
  return createFetchStub({
    "GET /api/credentials": () => ({ credentials }),
    "GET /api/credentials/health": () => ({
      health: [health({ breakerState: "open", consecutiveFailures: 4 })],
      quota: [quota({ used: 950, limit: 1_000 })],
    }),
    "GET /api/settings": () => ({ settings }),
    ...overrides,
  });
}

describe("AccountsBoard", () => {
  test("groups accounts under their provider and summarises what is routable", async () => {
    stubAccounts();
    renderWithProviders(<AccountsBoard />);

    expect(await screen.findByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("OpenAI")).toBeTruthy();
    expect(screen.getByText("1 of 2 accounts are enabled and eligible for routing.")).toBeTruthy();
  });

  test("shows the fault and the quota windows on the row", async () => {
    stubAccounts();
    renderWithProviders(<AccountsBoard />);

    expect(await screen.findByText("breaker open")).toBeTruthy();
    expect(screen.getByLabelText("5h window, 95% used")).toBeTruthy();
  });

  test("draws every reported window, not just the tightest", async () => {
    // A five-hour window at 95% and a weekly one at 20% mean "pause for an
    // hour"; the reverse means "this account is done for the week". One bar
    // cannot say which.
    stubAccounts({
      "GET /api/credentials/health": () => ({
        health: [health()],
        quota: [
          quota({ windowType: "weekly", used: 200, limit: 1_000 }),
          quota({ windowType: "fiveHour", used: 950, limit: 1_000 }),
        ],
      }),
    });
    renderWithProviders(<AccountsBoard />);

    expect(await screen.findByLabelText("5h window, 95% used")).toBeTruthy();
    expect(screen.getByLabelText("7d window, 20% used")).toBeTruthy();
  });

  test("gives every quota window the same wider bar track", async () => {
    stubAccounts({
      "GET /api/credentials/health": () => ({
        health: [health()],
        quota: [
          quota({ windowType: "fiveHour", used: 950, limit: 1_000 }),
          quota({ windowType: "weekly", used: 200, limit: 1_000 }),
        ],
      }),
    });
    renderWithProviders(<AccountsBoard />);

    const fiveHour = await screen.findByLabelText("5h window, 95% used");
    const weekly = screen.getByLabelText("7d window, 20% used");
    const quotaHeader = screen.getAllByRole("columnheader", { name: "Quota" })[0];

    expect(getComputedStyle(quotaHeader as HTMLElement).width).toBe("240px");
    expect(getComputedStyle(fiveHour.parentElement as HTMLElement).gridTemplateColumns).toBe(
      "96px 1fr",
    );
    expect(getComputedStyle(weekly.parentElement as HTMLElement).gridTemplateColumns).toBe(
      "96px 1fr",
    );
  });

  test("turning an account off patches only that field", async () => {
    const user = userEvent.setup();
    const stub = stubAccounts({ "PATCH /api/credentials/cred-1": () => ({ ok: true }) });
    renderWithProviders(<AccountsBoard />);

    await user.click(await screen.findByLabelText("Route to claude-main"));

    await waitFor(() => {
      const patch = stub.calls.find((call) => call.init?.method === "PATCH");
      expect(patch?.url).toBe("/api/credentials/cred-1");
      expect(patch?.init?.body).toBe(JSON.stringify({ enabled: false }));
    });
  });

  test("committing a new tier sends it once, on blur", async () => {
    const user = userEvent.setup();
    const stub = stubAccounts({ "PATCH /api/credentials/cred-1": () => ({ ok: true }) });
    renderWithProviders(<AccountsBoard />);

    const tier = await screen.findByLabelText("Tier for claude-main");
    await user.clear(tier);
    await user.type(tier, "3");
    expect(stub.calls.some((call) => call.init?.method === "PATCH")).toBe(false);

    await user.tab();
    await waitFor(() => {
      const patches = stub.calls.filter((call) => call.init?.method === "PATCH");
      expect(patches).toHaveLength(1);
      expect(patches[0]?.init?.body).toBe(JSON.stringify({ tier: 3 }));
    });
  });

  test("an invalid tier is refused and the field snaps back", async () => {
    const user = userEvent.setup();
    const stub = stubAccounts({ "PATCH /api/credentials/cred-1": () => ({ ok: true }) });
    renderWithProviders(<AccountsBoard />);

    const tier = (await screen.findByLabelText("Tier for claude-main")) as HTMLInputElement;
    await user.clear(tier);
    await user.type(tier, "0");
    await user.tab();

    await waitFor(() => expect(tier.value).toBe("1"));
    expect(stub.calls.some((call) => call.init?.method === "PATCH")).toBe(false);
  });

  test("removing an account states the consequence before it happens", async () => {
    const user = userEvent.setup();
    const stub = stubAccounts({ "DELETE /api/credentials/cred-1": () => ({ ok: true }) });
    renderWithProviders(<AccountsBoard />);

    await user.click(await screen.findByLabelText("Remove claude-main"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/deletes its stored token/i)).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Remove account" }));
    await waitFor(() => {
      expect(stub.calls.some((call) => call.init?.method === "DELETE")).toBe(true);
    });
  });

  test("keeps the selected existing custom endpoint visible", async () => {
    const user = userEvent.setup();
    stubAccounts({
      "GET /api/credentials": () => ({
        credentials: [
          credential({
            id: "custom-1",
            provider: "custom",
            providerData: {
              endpointId: "local-vllm",
              endpointLabel: "Local vLLM",
              origin: "http://localhost:8000",
              protocol: "chat_completions",
            },
          }),
        ],
      }),
    });
    renderWithProviders(<AccountsBoard />);

    await user.click(
      (await screen.findAllByRole("button", { name: "Connect an account" }))[0] as HTMLElement,
    );
    await user.selectOptions(screen.getByLabelText("Provider"), "custom");
    const endpoint = screen.getByLabelText("Existing endpoint") as HTMLSelectElement;
    await user.selectOptions(endpoint, "local-vllm");

    expect(endpoint.value).toBe("local-vllm");
    expect(endpoint.selectedOptions[0]?.textContent).toBe("Local vLLM");
  });

  test("returns to a blank endpoint form after reselecting create new endpoint", async () => {
    const user = userEvent.setup();
    stubAccounts({
      "GET /api/credentials": () => ({
        credentials: [
          credential({
            id: "custom-1",
            provider: "custom",
            providerData: {
              endpointId: "local-vllm",
              endpointLabel: "Local vLLM",
              origin: "http://localhost:8000",
              protocol: "chat_completions",
            },
          }),
        ],
      }),
    });
    renderWithProviders(<AccountsBoard />);

    await user.click(
      (await screen.findAllByRole("button", { name: "Connect an account" }))[0] as HTMLElement,
    );
    await user.selectOptions(screen.getByLabelText("Provider"), "custom");
    const endpoint = screen.getByLabelText("Existing endpoint") as HTMLSelectElement;
    await user.selectOptions(endpoint, "local-vllm");
    await user.selectOptions(endpoint, "");

    expect(endpoint.value).toBe("");
    expect((screen.getByLabelText("Endpoint ID") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Endpoint label") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Server origin") as HTMLInputElement).value).toBe("");
  });

  test("names the upstream path each protocol calls", async () => {
    const user = userEvent.setup();
    stubAccounts({});
    renderWithProviders(<AccountsBoard />);

    await user.click(
      (await screen.findAllByRole("button", { name: "Connect an account" }))[0] as HTMLElement,
    );
    await user.selectOptions(screen.getByLabelText("Provider"), "custom");

    const protocol = screen.getByLabelText("Protocol") as HTMLSelectElement;
    expect(
      within(protocol).getByRole("option", { name: "Chat Completions (/v1/chat/completions)" }),
    ).toBeTruthy();
    expect(
      within(protocol).getByRole("option", { name: "Responses (/v1/responses)" }),
    ).toBeTruthy();
  });

  test("creates an OpenAI-compatible credential and warns for HTTP", async () => {
    const user = userEvent.setup();
    const stub = stubAccounts({ "POST /api/credentials": () => ({ credential: credential() }) });
    renderWithProviders(<AccountsBoard />);

    await user.click(
      (await screen.findAllByRole("button", { name: "Connect an account" }))[0] as HTMLElement,
    );
    await user.selectOptions(screen.getByLabelText("Provider"), "custom");
    await user.type(screen.getByLabelText("Endpoint ID"), "local-vllm");
    await user.type(screen.getByLabelText("Endpoint label"), "Local vLLM");
    await user.type(screen.getByLabelText("Server origin"), "http://localhost:8000");
    await user.selectOptions(screen.getByLabelText("Protocol"), "chat_completions");
    await user.type(screen.getByLabelText("API key"), "test-provider-key");

    expect(screen.getByText(/plaintext transport/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add API key" }));
    await waitFor(() => {
      const call = stub.calls.find(
        (entry) => entry.url === "/api/credentials" && entry.init?.method === "POST",
      );
      expect(call?.init?.body as string).toContain('"endpointId":"local-vllm"');
    });
  });

  test("an empty gateway says what to do instead of showing a bare table", async () => {
    createFetchStub({
      "GET /api/credentials": () => ({ credentials: [] }),
      "GET /api/credentials/health": () => ({ health: [], quota: [] }),
    });
    renderWithProviders(<AccountsBoard />);

    expect(
      await screen.findByText(
        "No provider credentials are connected, so every request fails at the router.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Connect an account" }).length).toBeGreaterThan(0);
  });

  test("a failed read reports the gateway's message", async () => {
    createFetchStub({
      "GET /api/credentials": () => ({
        status: 500,
        body: { error: { code: "INTERNAL", message: "internal error" } },
      }),
      "GET /api/credentials/health": () => ({ health: [], quota: [] }),
    });
    renderWithProviders(<AccountsBoard />);

    expect(await screen.findByText("internal error")).toBeTruthy();
  });

  test("a credential that never expires says so", async () => {
    createFetchStub({
      "GET /api/credentials": () => ({
        credentials: [credential({ expiresAt: null, authType: "apiKey" })],
      }),
      "GET /api/credentials/health": () => ({ health: [], quota: [] }),
    });
    renderWithProviders(<AccountsBoard />);

    expect(await screen.findByText("never")).toBeTruthy();
    expect(screen.getByText("api key")).toBeTruthy();
  });

  test("an account the provider repudiated asks for a reconnect", async () => {
    stubAccounts({
      "GET /api/credentials": () => ({
        credentials: [
          credential({
            enabled: false,
            disabledReason: "tokenRejected",
            disabledAt: NOW - 60_000,
          }),
        ],
      }),
    });
    renderWithProviders(<AccountsBoard />);

    expect(
      await screen.findByText("reconnect needed — provider rejected the refresh token"),
    ).toBeTruthy();
  });

  test("an account the operator switched off reads as disabled, not as broken", async () => {
    stubAccounts({
      "GET /api/credentials": () => ({
        credentials: [credential({ enabled: false, disabledReason: "manual", disabledAt: NOW })],
      }),
    });
    renderWithProviders(<AccountsBoard />);

    expect(await screen.findByText("disabled")).toBeTruthy();
    expect(screen.queryByText(/reconnect needed/)).toBeNull();
  });

  test("a fresh quota reading is shown with when the window resets", async () => {
    // Against the real clock, because the board reads Date.now() rather than
    // the fixture's fixed instant.
    const now = Date.now();
    stubAccounts({
      "GET /api/credentials/health": () => ({
        health: [health()],
        quota: [quota({ observedAt: now - 30_000, resetsAt: now + 3_600_000 })],
      }),
    });
    renderWithProviders(<AccountsBoard />);

    // The board reads its own Date.now() microseconds later, so the countdown
    // is matched by shape rather than to the millisecond.
    expect(await screen.findByText(/^5h · resets in \d+[mh]$/)).toBeTruthy();
  });

  test("a reading older than three poll intervals is labelled stale", async () => {
    const now = Date.now();
    stubAccounts({
      "GET /api/credentials/health": () => ({
        health: [health()],
        quota: [quota({ observedAt: now - 3_600_000, resetsAt: now + 600_000 })],
      }),
    });
    renderWithProviders(<AccountsBoard />);

    expect(await screen.findByText(/stale, read 1h ago/)).toBeTruthy();
  });

  test("an account the provider reports nothing for reads as unknown", async () => {
    stubAccounts({
      "GET /api/credentials/health": () => ({ health: [health()], quota: [] }),
    });
    renderWithProviders(<AccountsBoard />);

    expect(await screen.findAllByText("unknown")).toBeTruthy();
  });
});
