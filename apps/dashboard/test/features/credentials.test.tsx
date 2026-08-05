import { afterEach, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HealthPill } from "../../src/components/Health.tsx";
import { QuotaBar } from "../../src/components/QuotaBar.tsx";
import { CredentialsScreen } from "../../src/routes/_app.credentials.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { credentialFixture, healthFixture, NOW, quotaFixture } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
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

test("quota bar shows usage only when a limit is known", () => {
  const { rerender } = renderWithProviders(<QuotaBar window={quotaFixture()} />);
  expect(screen.getByText("five hour quota")).toBeTruthy();
  expect(screen.getByText("25% used")).toBeTruthy();

  rerender(<QuotaBar window={quotaFixture({ limit: null })} />);
  expect(screen.queryByText("five hour quota")).toBeNull();
});

test("saving inline tier and weight sends only the credential patch", async () => {
  const fetch = createFetchStub({
    "GET /api/credentials": () => ({ credentials: [credentialFixture()] }),
    "PATCH /api/credentials/c1": () => ({ ok: true }),
  });
  const user = userEvent.setup();

  renderWithProviders(<CredentialsScreen now={NOW} />);
  const card = await screen.findByText("work");
  const section = card.closest("section");
  if (section === null) throw new Error("credential card missing section");

  await user.clear(within(section).getByLabelText("Tier"));
  await user.type(within(section).getByLabelText("Tier"), "2");
  await user.clear(within(section).getByLabelText("Weight"));
  await user.type(within(section).getByLabelText("Weight"), "3");
  await user.click(within(section).getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(fetch.calls.filter((call) => call.url === "/api/credentials/c1")).toHaveLength(1),
  );
  const request = fetch.calls.find((call) => call.url === "/api/credentials/c1");
  expect(JSON.parse(String(request?.init?.body))).toEqual({ tier: 2, weight: 3 });
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
