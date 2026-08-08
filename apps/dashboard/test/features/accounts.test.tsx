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
