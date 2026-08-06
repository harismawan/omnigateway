import { afterEach, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HealthPill } from "../../src/components/Health.tsx";
import { QuotaBar } from "../../src/components/QuotaBar.tsx";
import { CredentialsScreen, credentialSummary } from "../../src/routes/_app.credentials.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { credentialFixture, healthFixture, NOW, quotaFixture } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
const realConfirm = globalThis.confirm;
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.confirm = realConfirm;
});

test("credential summary counts connected, healthy, impaired, and quota warning accounts", () => {
  const credentials = [
    credentialFixture({ id: "healthy", provider: "anthropic" }),
    credentialFixture({ id: "limited", provider: "openai" }),
    credentialFixture({ id: "broken", provider: "kimi" }),
  ];
  const health = [
    healthFixture({ credentialId: "healthy" }),
    healthFixture({ credentialId: "limited", rateLimitedUntil: NOW + 60_000 }),
    healthFixture({ credentialId: "broken", breakerState: "open", consecutiveFailures: 2 }),
  ];
  const quota = [
    quotaFixture({ credentialId: "limited", used: 90, limit: 100 }),
    quotaFixture({ credentialId: "limited", windowType: "daily", used: 95, limit: 100 }),
  ];

  expect(credentialSummary(credentials, health, quota, NOW)).toEqual({
    connected: 3,
    healthy: 1,
    impaired: 2,
    quotaWarnings: 1,
  });
});

test("credential summary ignores quota from removed credentials and non-finite limits", () => {
  const credentials = [credentialFixture({ id: "current" })];
  const quota = [
    quotaFixture({ credentialId: "removed", used: 100, limit: 100 }),
    quotaFixture({ credentialId: "current", used: 100, limit: Number.POSITIVE_INFINITY }),
  ];

  expect(credentialSummary(credentials, [], quota, NOW).quotaWarnings).toBe(0);
});

test("credentials workspace renders summary, provider headings, and empty provider action", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({
      credentials: [credentialFixture({ id: "a", provider: "openai", label: "backup" })],
    }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
  });

  renderWithProviders(<CredentialsScreen now={NOW} />);

  for (const label of [
    "Connected accounts",
    "Healthy accounts",
    "Impaired accounts",
    "Quota warnings",
  ]) {
    expect(await screen.findByRole("group", { name: label })).toBeTruthy();
  }
  expect(screen.getByRole("heading", { name: "Anthropic" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "OpenAI" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Kimi Coding" })).toBeTruthy();
  expect(screen.getByText("No Anthropic accounts connected")).toBeTruthy();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Connect provider" }));
  expect(screen.getByRole("dialog", { name: "Connect provider" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Anthropic" })).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Connect provider" })).toBeNull(),
  );
});

test("accounts are grouped under their provider heading", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({
      credentials: [
        credentialFixture({ id: "a", provider: "anthropic", label: "primary" }),
        credentialFixture({ id: "b", provider: "openai", label: "backup" }),
      ],
    }),
  });

  renderWithProviders(<CredentialsScreen now={NOW} />);

  expect(await screen.findByRole("heading", { name: "Anthropic" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "OpenAI" })).toBeTruthy();
  expect(screen.getByText("primary")).toBeTruthy();
  expect(screen.getByText("backup")).toBeTruthy();
});

test("renders every provider group with an add account seam", async () => {
  createFetchStub({ "GET /api/credentials": () => ({ credentials: [] }) });
  const user = userEvent.setup();
  const added: string[] = [];

  renderWithProviders(
    <CredentialsScreen now={NOW} onAddProvider={(provider) => added.push(provider)} />,
  );

  expect(await screen.findByRole("heading", { name: "Anthropic" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "OpenAI" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Kimi Coding" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Add Anthropic account" }));
  expect(added).toEqual(["anthropic"]);
});

test("selecting OpenAI replaces chooser with focused OpenAI connection dialog", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({ credentials: [] }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
  });
  const user = userEvent.setup();

  renderWithProviders(<CredentialsScreen now={NOW} />);

  await screen.findByRole("button", { name: "Connect provider" });
  const trigger = screen.getByRole("button", { name: "Connect provider" });
  await user.click(screen.getByRole("button", { name: "Connect provider" }));
  const chooser = await screen.findByRole("dialog", { name: "Connect provider" });
  await user.click(within(chooser).getByRole("button", { name: "OpenAI" }));

  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Connect provider" })).toBeNull();
    expect(screen.getAllByRole("dialog", { name: "Connect OpenAI" })).toHaveLength(1);
  });
  const dialog = screen.getByRole("dialog", { name: "Connect OpenAI" });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  expect(document.activeElement).not.toBe(trigger);
});

test("chooser-selected ConnectDialog close restores header trigger focus", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({ credentials: [] }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
  });
  const user = userEvent.setup();

  renderWithProviders(<CredentialsScreen now={NOW} />);

  await screen.findByRole("button", { name: "Connect provider" });
  const trigger = screen.getByRole("button", { name: "Connect provider" });
  await user.click(screen.getByRole("button", { name: "Connect provider" }));
  const chooser = await screen.findByRole("dialog", { name: "Connect provider" });
  await user.click(within(chooser).getByRole("button", { name: "OpenAI" }));
  const dialog = await screen.findByRole("dialog", { name: "Connect OpenAI" });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connect OpenAI" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("chooser-selected ConnectDialog Escape restores header trigger focus", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({ credentials: [] }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
  });
  const user = userEvent.setup();

  renderWithProviders(<CredentialsScreen now={NOW} />);

  await screen.findByRole("button", { name: "Connect provider" });
  const trigger = screen.getByRole("button", { name: "Connect provider" });
  await user.click(screen.getByRole("button", { name: "Connect provider" }));
  const chooser = await screen.findByRole("dialog", { name: "Connect provider" });
  await user.click(within(chooser).getByRole("button", { name: "OpenAI" }));
  await screen.findByRole("dialog", { name: "Connect OpenAI" });
  await user.keyboard("{Escape}");

  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connect OpenAI" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("provider chooser Cancel closes and restores trigger focus", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({ credentials: [] }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
  });
  const user = userEvent.setup();

  renderWithProviders(<CredentialsScreen now={NOW} />);

  await screen.findByRole("button", { name: "Connect provider" });
  const trigger = screen.getByRole("button", { name: "Connect provider" });
  await user.click(trigger);
  const chooser = await screen.findByRole("dialog", { name: "Connect provider" });
  await user.click(within(chooser).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Connect provider" })).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("provider chooser Escape closes and restores trigger focus", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({ credentials: [] }),
    "GET /api/credentials/health": () => ({ health: [], quota: [] }),
  });
  const user = userEvent.setup();

  renderWithProviders(<CredentialsScreen now={NOW} />);

  await screen.findByRole("button", { name: "Connect provider" });
  const trigger = screen.getByRole("button", { name: "Connect provider" });
  await user.click(trigger);
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Connect provider" })).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("provider chooser sends selected provider through existing add callback", async () => {
  createFetchStub({ "GET /api/credentials": () => ({ credentials: [] }) });
  const user = userEvent.setup();
  const added: string[] = [];

  renderWithProviders(
    <CredentialsScreen now={NOW} onAddProvider={(provider) => added.push(provider)} />,
  );

  await screen.findByRole("button", { name: "Connect provider" });
  await user.click(screen.getByRole("button", { name: "Connect provider" }));
  await user.click(await screen.findByRole("button", { name: "OpenAI" }));

  expect(added).toEqual(["openai"]);
});

test("health severity prioritizes breaker open over rate limiting", () => {
  renderWithProviders(
    <HealthPill
      health={[
        healthFixture({ breakerState: "open", consecutiveFailures: 3 }),
        healthFixture({ rateLimitedUntil: NOW + 60_000 }),
      ]}
      now={NOW}
    />,
  );

  expect(screen.getByText("breaker open")).toBeTruthy();
  expect(screen.getByText(/3 consecutive failures/)).toBeTruthy();
});

test("health uses mean TTFT across usable rows", () => {
  renderWithProviders(
    <HealthPill
      health={[healthFixture({ ewmaTtftMs: 100 }), healthFixture({ ewmaTtftMs: 300 })]}
      now={NOW}
    />,
  );

  expect(screen.getByText("TTFT 200ms")).toBeTruthy();
});

test("quota bar shows usage only when a limit is known", () => {
  const { rerender } = renderWithProviders(<QuotaBar window={quotaFixture()} />);
  expect(screen.getByText("five hour quota")).toBeTruthy();
  expect(screen.getByText("25% used")).toBeTruthy();

  rerender(<QuotaBar window={quotaFixture({ limit: null })} />);
  expect(screen.queryByText("five hour quota")).toBeNull();
});

test("saving changed enabled tier and weight sends the strict credential patch", async () => {
  const fetch = createFetchStub({
    "GET /api/credentials": () => ({ credentials: [credentialFixture()] }),
    "PATCH /api/credentials/c1": () => ({ ok: true }),
  });
  const user = userEvent.setup();

  renderWithProviders(<CredentialsScreen now={NOW} />);
  const card = await screen.findByText("work");
  const section = card.closest("section");
  if (section === null) throw new Error("credential card missing section");

  expect(within(section).getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  await user.click(within(section).getByRole("switch", { name: "Enabled" }));
  await user.clear(within(section).getByLabelText("Tier"));
  await user.type(within(section).getByLabelText("Tier"), "2");
  await user.clear(within(section).getByLabelText("Weight"));
  await user.type(within(section).getByLabelText("Weight"), "3");
  await user.click(within(section).getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(fetch.calls.filter((call) => call.url === "/api/credentials/c1")).toHaveLength(1),
  );
  const request = fetch.calls.find((call) => call.url === "/api/credentials/c1");
  expect(JSON.parse(String(request?.init?.body))).toEqual({ enabled: false, tier: 2, weight: 3 });
});

test("invalid tier and weight keep save disabled", async () => {
  createFetchStub({ "GET /api/credentials": () => ({ credentials: [credentialFixture()] }) });
  const user = userEvent.setup();

  renderWithProviders(<CredentialsScreen now={NOW} />);
  const card = await screen.findByText("work");
  const section = card.closest("section");
  if (section === null) throw new Error("credential card missing section");

  await user.clear(within(section).getByLabelText("Tier"));
  await user.type(within(section).getByLabelText("Tier"), "0.5");
  expect(within(section).getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  await user.clear(within(section).getByLabelText("Tier"));
  await user.type(within(section).getByLabelText("Tier"), "2");
  await user.clear(within(section).getByLabelText("Weight"));
  await user.type(within(section).getByLabelText("Weight"), "0");
  expect(within(section).getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
});

test("deleting a confirmed credential uses the delete endpoint", async () => {
  globalThis.confirm = () => true;
  const fetch = createFetchStub({
    "GET /api/credentials": () => ({ credentials: [credentialFixture()] }),
    "DELETE /api/credentials/c1": () => ({ ok: true }),
  });
  const user = userEvent.setup();

  renderWithProviders(<CredentialsScreen now={NOW} />);
  await user.click(await screen.findByRole("button", { name: "Delete" }));

  await waitFor(() =>
    expect(fetch.calls.filter((call) => call.url === "/api/credentials/c1")).toHaveLength(1),
  );
  expect(fetch.calls.find((call) => call.url === "/api/credentials/c1")?.init?.method).toBe(
    "DELETE",
  );
});

test("credential health and quota render from the supplementary endpoint", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({
      credentials: [credentialFixture({ id: "c1", provider: "anthropic", label: "primary" })],
    }),
    "GET /api/credentials/health": () => ({
      health: [
        healthFixture({
          credentialId: "c1",
          breakerState: "open",
          consecutiveFailures: 4,
          openedAt: NOW - 5_000,
        }),
      ],
      quota: [quotaFixture({ credentialId: "c1", used: 250, limit: 1_000 })],
    }),
  });

  renderWithProviders(<CredentialsScreen now={NOW} />);

  expect(await screen.findByText(/4 consecutive failures/)).toBeTruthy();
  expect(screen.getByText(/25%/)).toBeTruthy();
});

test("a failed health fetch degrades the card instead of hiding the credential", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({
      credentials: [credentialFixture({ id: "c1", provider: "anthropic", label: "primary" })],
    }),
    "GET /api/credentials/health": () => ({
      status: 500,
      body: { error: { code: "INTERNAL", message: "db locked" } },
    }),
  });

  renderWithProviders(<CredentialsScreen now={NOW} />);

  expect(await screen.findByText("primary")).toBeTruthy();
  expect(screen.getByText("Health unavailable")).toBeTruthy();
});

test("a failed save renders the gateway error", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({ credentials: [credentialFixture()] }),
    "PATCH /api/credentials/c1": () => ({
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: "tier is invalid" } },
    }),
  });
  const user = userEvent.setup();

  renderWithProviders(<CredentialsScreen now={NOW} />);
  const card = await screen.findByText("work");
  const section = card.closest("section");
  if (section === null) throw new Error("credential card missing section");
  await user.clear(within(section).getByLabelText("Tier"));
  await user.type(within(section).getByLabelText("Tier"), "2");
  await user.click(within(section).getByRole("button", { name: "Save" }));

  expect(await screen.findByText("tier is invalid")).toBeTruthy();
});

test("a failed list renders the gateway error rather than an empty page", async () => {
  createFetchStub({
    "GET /api/credentials": () => ({
      status: 500,
      body: { error: { code: "INTERNAL", message: "database is locked" } },
    }),
  });

  renderWithProviders(<CredentialsScreen now={NOW} />);

  expect(await screen.findByText("database is locked")).toBeTruthy();
});
