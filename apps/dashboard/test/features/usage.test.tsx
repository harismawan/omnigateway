import { afterEach, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { totals, UsageScreen } from "../../src/routes/_app.usage.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { bucketFixture, logFixture, NOW } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ROWS = [
  bucketFixture({
    key: "claude-opus-4",
    requests: 100,
    inputTokens: 900_000,
    outputTokens: 100_000,
    costUsd: 21,
    errors: 4,
  }),
  bucketFixture({
    key: "gpt-5",
    requests: 50,
    inputTokens: 100_000,
    outputTokens: 20_000,
    costUsd: 3,
    errors: 0,
  }),
];

function stubUsage(rows = ROWS, logs = [logFixture()]) {
  return createFetchStub({
    "GET /api/usage": () => ({ rows }),
    "GET /api/logs": () => ({ logs }),
  });
}

test("totals sums every bucket", () => {
  expect(totals(ROWS)).toEqual({
    requests: 150,
    inputTokens: 1_000_000,
    outputTokens: 120_000,
    costUsd: 24,
    errors: 4,
  });
});

test("totals of nothing is zero, not NaN", () => {
  expect(totals([])).toEqual({
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    errors: 0,
  });
});

test("the stat cards show exactly requests, tokens, estimated cost, and error rate", async () => {
  stubUsage();
  renderWithProviders(<UsageScreen now={NOW} />);

  await screen.findByRole("group", { name: "Requests" });
  expect(
    screen.getAllByRole("group").filter((group) => group.getAttribute("aria-label") !== null),
  ).toHaveLength(4);
  expect(within(screen.getByRole("group", { name: "Requests" })).getByText("150")).toBeDefined();
  expect(
    within(screen.getByRole("group", { name: "Estimated cost" })).getByText("$24.00"),
  ).toBeDefined();
  expect(within(screen.getByRole("group", { name: "Tokens" })).getByText("1.1M")).toBeDefined();
  expect(within(screen.getByRole("group", { name: "Error rate" })).getByText("2.7%")).toBeDefined();
});

test("chart metric radios update chart without dangling controls", async () => {
  stubUsage();
  renderWithProviders(<UsageScreen now={NOW} />);

  const group = await screen.findByRole("group", { name: "Chart metric" });
  const metrics = [
    ["Requests", "Requests chart"],
    ["Tokens", "Tokens chart"],
    ["Estimated cost", "Estimated cost chart"],
    ["Errors", "Errors chart"],
  ] as const;

  const user = userEvent.setup();
  for (const [name, chartName] of metrics) {
    const radio = within(group).getByRole<HTMLInputElement>("radio", { name });
    expect(radio).toBeDefined();
    await user.click(radio);
    expect(radio.checked).toBe(true);
    expect(await screen.findByLabelText(chartName)).toBeDefined();
    expect(radio.getAttribute("aria-controls")).toBeNull();
  }

  expect(screen.getByRole("table", { name: "Usage breakdown" })).toBeDefined();
});

test("the error rate of an idle window is a dash, not a division by zero", async () => {
  stubUsage([]);
  renderWithProviders(<UsageScreen now={NOW} />);
  expect(
    within(await screen.findByRole("group", { name: /error rate/i })).getByText("—"),
  ).toBeDefined();
});

test("an empty usage window explains that it has no requests", async () => {
  stubUsage([]);
  renderWithProviders(<UsageScreen now={NOW} />);

  expect(await screen.findByText("No requests in this window.")).toBeDefined();
  expect(screen.queryByLabelText("Cost chart")).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
});

test("each bucket is a table row with its share of the cost", async () => {
  stubUsage();
  renderWithProviders(<UsageScreen now={NOW} />);
  const row = await screen.findByRole("row", { name: /claude-opus-4/ });
  expect(within(row).getByText("100")).toBeDefined();
  expect(within(row).getByText("$21.00")).toBeDefined();
});

test("rows are ordered by cost so the expensive slice is first", async () => {
  stubUsage([
    bucketFixture({ key: "cheap", costUsd: 1 }),
    bucketFixture({ key: "pricey", costUsd: 99 }),
  ]);
  renderWithProviders(<UsageScreen now={NOW} />);
  await screen.findByRole("row", { name: /pricey/ });
  expect(
    screen.getAllByRole("cell", { name: /cheap|pricey/ }).map((cell) => cell.textContent),
  ).toEqual(["pricey", "cheap"]);
});

test("grouping uses native radio inputs in a named fieldset", async () => {
  stubUsage();
  renderWithProviders(<UsageScreen now={NOW} />);
  await screen.findByRole("row", { name: /claude-opus-4/ });

  const group = screen.getByRole("group", { name: "Group by" });
  expect(within(group).getByRole("radio", { name: "Model" })).toBeDefined();
  expect(within(group).getByRole("radio", { name: "Credential" })).toBeDefined();
});

test("switching the grouping refetches with the new groupBy", async () => {
  const stub = stubUsage();
  renderWithProviders(<UsageScreen now={NOW} />);
  await screen.findByRole("row", { name: /claude-opus-4/ });
  await (await userEvent.setup()).click(screen.getByRole("radio", { name: "Credential" }));
  const urls = stub.calls.map((call) => call.url).filter((url) => url.startsWith("/api/usage"));
  expect(urls.some((url) => url.includes("groupBy=model"))).toBe(true);
  expect(urls.some((url) => url.includes("groupBy=credential"))).toBe(true);
});

test("switching the range moves the since boundary", async () => {
  const stub = stubUsage();
  renderWithProviders(<UsageScreen now={NOW} />);
  await screen.findByRole("row", { name: /claude-opus-4/ });
  await (await userEvent.setup()).selectOptions(screen.getByLabelText(/range/i), "7d");
  const since = stub.calls
    .map((call) => call.url)
    .filter((url) => url.startsWith("/api/usage"))
    .map((url) => Number(new URL(url, "http://x").searchParams.get("since")));
  expect(since).toContain(NOW - 86_400_000);
  expect(since).toContain(NOW - 7 * 86_400_000);
});

test("rate limit sample appears as secondary operational text", async () => {
  stubUsage(ROWS, [
    logFixture({ id: "a", status: 429, errorCode: "RATE_LIMIT" }),
    logFixture({ id: "b", status: 200, errorCode: null }),
    logFixture({ id: "c", status: 200, errorCode: null }),
    logFixture({ id: "d", status: 200, errorCode: null }),
  ]);
  renderWithProviders(<UsageScreen now={NOW} />);
  expect(await screen.findByText(/rate limited: 25\.0% from last 4 requests/i)).toBeDefined();
});

test("a failed load offers a retry instead of an empty chart", async () => {
  createFetchStub({
    "GET /api/usage": () => ({
      status: 500,
      body: { error: { code: "INTERNAL", message: "boom" } },
    }),
    "GET /api/logs": () => ({ logs: [] }),
  });
  renderWithProviders(<UsageScreen now={NOW} />);
  expect(await screen.findByText("boom")).toBeDefined();
  expect(screen.getByRole("button", { name: /retry/i })).toBeDefined();
});
