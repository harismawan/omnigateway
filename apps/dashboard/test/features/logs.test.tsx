import { afterEach, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LogsScreen, POLL_MS } from "../../src/routes/_app.logs.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { logFixture, NOW } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("each recent request is a row naming the model that served it", async () => {
  createFetchStub({
    "GET /api/logs": () => ({
      logs: [
        logFixture({ id: "r1", requestedModel: "fast", resolvedModel: "claude-haiku-4" }),
        logFixture({ id: "r2", requestedModel: "smart", resolvedModel: "gpt-5" }),
      ],
    }),
  });
  renderWithProviders(<LogsScreen now={NOW} />);

  const row = await screen.findByRole("row", { name: /claude-haiku-4/ });
  expect(within(row).getByText("fast")).toBeDefined();
  expect(screen.getByRole("row", { name: /gpt-5/ })).toBeDefined();
});

test("a failed request shows its status and error code", async () => {
  createFetchStub({
    "GET /api/logs": () => ({
      logs: [logFixture({ status: 503, errorCode: "NO_CANDIDATES", resolvedModel: null })],
    }),
  });
  renderWithProviders(<LogsScreen now={NOW} />);

  const row = await screen.findByRole("row", { name: /NO_CANDIDATES/ });
  expect(within(row).getByText("503")).toBeDefined();
});

test("expanding a row shows the recorded detail", async () => {
  createFetchStub({
    "GET /api/logs": () => ({
      logs: [logFixture({ ttftMs: 410, durationMs: 2_100, costUsd: 0.0435, attempts: 1 })],
    }),
  });
  renderWithProviders(<LogsScreen now={NOW} />);
  await (await userEvent.setup()).click(
    await screen.findByRole("button", { name: /details for r1/i }),
  );

  expect(screen.getAllByText("410ms").length).toBeGreaterThan(0);
  expect(screen.getAllByText("2.1s").length).toBeGreaterThan(0);
  expect(screen.getAllByText("$0.04").length).toBeGreaterThan(0);
});

test("expanded detail identifies the request and its API key", async () => {
  createFetchStub({ "GET /api/logs": () => ({ logs: [logFixture({ apiKeyId: "key-42" })] }) });
  renderWithProviders(<LogsScreen now={NOW} />);
  await (await userEvent.setup()).click(
    await screen.findByRole("button", { name: /details for r1/i }),
  );

  expect(screen.getByText("Request").nextElementSibling?.textContent).toBe("r1");
  expect(screen.getByText("API key").nextElementSibling?.textContent).toBe("key-42");
  expect(screen.getByText("Tokens").nextElementSibling?.textContent).toBe("1.2K in · 340 out");
  expect(screen.getByText("Cache").nextElementSibling?.textContent).toBe("0 read · 0 write");
});

test("expanded detail falls back when its API key is unavailable", async () => {
  createFetchStub({ "GET /api/logs": () => ({ logs: [logFixture({ apiKeyId: null })] }) });
  renderWithProviders(<LogsScreen now={NOW} />);
  await (await userEvent.setup()).click(
    await screen.findByRole("button", { name: /details for r1/i }),
  );

  expect(screen.getByText("API key").nextElementSibling?.textContent).toBe("—");
});

test("a multi-attempt request says the earlier attempts are not retained", async () => {
  createFetchStub({ "GET /api/logs": () => ({ logs: [logFixture({ attempts: 3 })] }) });
  renderWithProviders(<LogsScreen now={NOW} />);
  await (await userEvent.setup()).click(
    await screen.findByRole("button", { name: /details for r1/i }),
  );

  expect(screen.getByText(/3 attempts/i)).toBeDefined();
  expect(screen.getByText(/earlier attempts are not retained/i)).toBeDefined();
});

test("a single-attempt request does not show the retention caveat", async () => {
  createFetchStub({ "GET /api/logs": () => ({ logs: [logFixture({ attempts: 1 })] }) });
  renderWithProviders(<LogsScreen now={NOW} />);
  await (await userEvent.setup()).click(
    await screen.findByRole("button", { name: /details for r1/i }),
  );

  expect(screen.queryByText(/earlier attempts are not retained/i)).toBeNull();
});

test("degradations are listed so a silently downgraded request is visible", async () => {
  createFetchStub({
    "GET /api/logs": () => ({ logs: [logFixture({ degradations: ["droppedThinking"] })] }),
  });
  renderWithProviders(<LogsScreen now={NOW} />);
  await (await userEvent.setup()).click(
    await screen.findByRole("button", { name: /details for r1/i }),
  );

  expect(screen.getByText(/degradations: droppedThinking/i)).toBeDefined();
});

test("the tail polls every three seconds", async () => {
  expect(POLL_MS).toBe(3_000);
  let call = 0;
  const stub = createFetchStub({
    "GET /api/logs": () => ({ logs: [logFixture({ id: `r${++call}` })] }),
  });
  renderWithProviders(<LogsScreen now={NOW} pollMs={50} />);
  await screen.findByRole("button", { name: /details for r1/i });

  await waitFor(() =>
    expect(stub.calls.filter((call) => call.url.startsWith("/api/logs")).length).toBeGreaterThan(1),
  );
});

test("pausing stops polling before the three-second interval", async () => {
  const stub = createFetchStub({ "GET /api/logs": () => ({ logs: [logFixture()] }) });
  renderWithProviders(<LogsScreen now={NOW} pollMs={50} />);
  await screen.findByRole("button", { name: /details for r1/i });
  await (await userEvent.setup()).click(screen.getByRole("button", { name: /pause/i }));

  const after = stub.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(stub.calls.length).toBe(after);
  expect(screen.getByRole("button", { name: /resume/i })).toBeDefined();
});

test("changing the limit refetches with the new limit", async () => {
  const stub = createFetchStub({ "GET /api/logs": () => ({ logs: [logFixture()] }) });
  renderWithProviders(<LogsScreen now={NOW} />);
  await screen.findByRole("button", { name: /details for r1/i });

  await (await userEvent.setup()).selectOptions(screen.getByLabelText(/rows/i), "500");
  await waitFor(() => expect(stub.calls.some((call) => call.url.includes("limit=500"))).toBe(true));
});

test("an empty tail says so rather than showing a bare header", async () => {
  createFetchStub({ "GET /api/logs": () => ({ logs: [] }) });
  renderWithProviders(<LogsScreen now={NOW} />);
  expect(await screen.findByText(/no requests yet/i)).toBeDefined();
});

test("a failed poll surfaces the error and keeps the last rows on screen", async () => {
  let fail = false;
  createFetchStub({
    "GET /api/logs": () =>
      fail
        ? { status: 500, body: { error: { code: "INTERNAL", message: "db locked" } } }
        : { logs: [logFixture()] },
  });
  renderWithProviders(<LogsScreen now={NOW} pollMs={50} />);
  await screen.findByRole("button", { name: /details for r1/i });

  fail = true;
  expect(await screen.findByText("db locked")).toBeDefined();
  expect(screen.getByRole("button", { name: /details for r1/i })).toBeDefined();
});
