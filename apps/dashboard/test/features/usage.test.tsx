import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageBoard } from "../../src/features/usage/UsageBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { apiKey, credential, usageBucket } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const HOUR_MS = 3_600_000;

function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

const NOW = Date.now();
const THIS_HOUR = String(Math.floor(NOW / HOUR_MS));
const TODAY = startOfDay(NOW);

/** One table per query shape, so a panel's assertion pins its own request. */
function rowsFor(url: string): { rows: unknown[] } {
  if (url.includes("groupBy=day")) {
    return {
      rows: [
        usageBucket({ key: String(TODAY), requests: 40, errors: 1, costUsd: 2 }),
        usageBucket({ key: String(TODAY - 86_400_000), requests: 4, errors: 0, costUsd: 0.2 }),
      ],
    };
  }
  if (url.includes("splitBy=provider")) {
    return {
      rows: [
        usageBucket({ key: THIS_HOUR, split: "anthropic", requests: 30, errors: 1, costUsd: 2 }),
        usageBucket({ key: THIS_HOUR, split: "openai", requests: 10, errors: 0, costUsd: 0.5 }),
      ],
    };
  }
  if (url.includes("splitBy=apiKey")) {
    return {
      rows: [
        usageBucket({ key: THIS_HOUR, split: "key-1", requests: 24, errors: 0, costUsd: 1.5 }),
        usageBucket({ key: THIS_HOUR, split: "unknown", requests: 2, errors: 2, costUsd: 0 }),
      ],
    };
  }
  if (url.includes("groupBy=requestedModel")) {
    return { rows: [usageBucket({ key: "fast", requests: 40, errors: 1, costUsd: 2.5 })] };
  }
  if (url.includes("groupBy=model")) {
    return { rows: [usageBucket({ key: "claude-opus-4", requests: 40, errors: 1, costUsd: 2.5 })] };
  }
  if (url.includes("groupBy=credential")) {
    return {
      rows: [
        usageBucket({ key: "cred-1", requests: 38, errors: 1, costUsd: 2.4 }),
        usageBucket({ key: "cred-gone", requests: 2, errors: 0, costUsd: 0.1 }),
      ],
    };
  }
  return {
    rows: [
      usageBucket({
        key: THIS_HOUR,
        requests: 10,
        errors: 1,
        costUsd: 0.5,
        inputTokens: 8_000,
        outputTokens: 2_000,
        cacheReadTokens: 5_000,
        cacheWriteTokens: 1_000,
        durationMsSum: 12_000,
      }),
    ],
  };
}

function stubUsage() {
  return createFetchStub({
    "GET /api/usage": ({ url }) => rowsFor(url),
    "GET /api/credentials": () => ({ credentials: [credential()] }),
    "GET /api/keys": () => ({ keys: [apiKey()] }),
  });
}

describe("UsageBoard", () => {
  test("totals the selected window", async () => {
    stubUsage();
    renderWithProviders(<UsageBoard />);

    expect(await screen.findByText("10 requests and $0.50 over the last 24 hours.")).toBeTruthy();
  });

  test("draws a year of days, one cell per day, labelled with its traffic", async () => {
    stubUsage();
    renderWithProviders(<UsageBoard />);

    // Tokens is the default lens, and the grid's name says which one paints it.
    const grid = await screen.findByRole("grid", {
      name: "Tokens per day over the last year",
    });
    // 53 weeks of 7 days, whatever the window the panels below are showing.
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(371);

    const today = new Date(TODAY).toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    expect(screen.getByLabelText(`${today}: 40 requests, 150k tokens, $2.00`)).toBeTruthy();
  });

  test("the activity grid reads a year from the rollup, not from the raw logs", async () => {
    const stub = stubUsage();
    renderWithProviders(<UsageBoard />);
    await screen.findByRole("grid", { name: "Tokens per day over the last year" });

    const activity = stub.calls.find((call) => call.url.includes("groupBy=day"));
    expect(activity?.url).toContain("grain=daily");
  });

  test("a long range switches every panel to the daily rollup", async () => {
    const user = userEvent.setup();
    const stub = stubUsage();
    renderWithProviders(<UsageBoard />);
    await screen.findByText(/over the last 24 hours\./);

    await user.click(screen.getByRole("button", { name: "1y" }));

    expect(await screen.findByText(/over the last 12 months\.$/)).toBeTruthy();
    await waitFor(() => {
      const split = stub.calls.filter(
        (call) => call.url.includes("splitBy=provider") && call.url.includes("grain=daily"),
      );
      expect(split.length).toBeGreaterThan(0);
    });
  });

  test("names providers and shows their share of the window", async () => {
    stubUsage();
    renderWithProviders(<UsageBoard />);

    // Once in the legend and once in the table: identity is never colour alone.
    expect(await screen.findAllByText("Anthropic")).toHaveLength(2);
    expect(screen.getAllByText("OpenAI")).toHaveLength(2);
    // 30 of 40 requests.
    expect(screen.getByText("75%")).toBeTruthy();
  });

  test("models rank by what actually served the traffic, and can switch to what was asked for", async () => {
    const user = userEvent.setup();
    const stub = stubUsage();
    renderWithProviders(<UsageBoard />);

    // The upstream model is the default: it is what the bill and the latency
    // belong to, whatever the client typed.
    expect(await screen.findByText("claude-opus-4")).toBeTruthy();
    expect(screen.getByText("Upstream model")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "As requested" }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.url.includes("groupBy=requestedModel"))).toBe(true);
    });
    expect(await screen.findByText("fast")).toBeTruthy();
  });

  test("names keys and accounts, keeps unattributed traffic, and falls back to the raw id", async () => {
    stubUsage();
    renderWithProviders(<UsageBoard />);

    expect(await screen.findByText("laptop")).toBeTruthy();
    expect(screen.getByText("Unattributed")).toBeTruthy();
    expect(screen.getByText("claude-main")).toBeTruthy();
    expect(screen.getByText("cred-gone")).toBeTruthy();
  });

  test("splits the token mix so cache traffic is visible on its own", async () => {
    stubUsage();
    renderWithProviders(<UsageBoard />);

    expect(await screen.findByText("Cache read")).toBeTruthy();
    expect(screen.getByText("Cache write")).toBeTruthy();
  });

  test("the ranking metric is a shared control across the breakdown panels", async () => {
    const user = userEvent.setup();
    stubUsage();
    renderWithProviders(<UsageBoard />);
    await screen.findByText("claude-opus-4");

    await user.click(screen.getByRole("button", { name: "Rank by cost" }));

    expect(screen.getByRole("button", { name: "Rank by cost" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect((await screen.findAllByText("$2.50")).length).toBeGreaterThan(0);
  });

  test("an empty window says how to get data, and the year grid keeps its squares", async () => {
    createFetchStub({
      "GET /api/usage": () => ({ rows: [] }),
      "GET /api/credentials": () => ({ credentials: [] }),
      "GET /api/keys": () => ({ keys: [] }),
    });
    renderWithProviders(<UsageBoard />);

    const messages = await screen.findAllByText(
      "No requests landed in this window. Widen the range, or send traffic through the gateway.",
    );
    expect(messages.length).toBeGreaterThan(0);

    // The year grid keeps its squares when there is nothing to colour them with.
    const grid = screen.getByRole("grid", { name: "Tokens per day over the last year" });
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(371);
    expect(screen.getAllByLabelText(/: 0 requests, 0 tokens, \$0$/)).toHaveLength(371);
  });

  test("a failed read reports the gateway's message", async () => {
    createFetchStub({
      "GET /api/usage": () => ({
        status: 500,
        body: { error: { code: "INTERNAL", message: "internal error" } },
      }),
      "GET /api/credentials": () => ({ credentials: [] }),
      "GET /api/keys": () => ({ keys: [] }),
    });
    renderWithProviders(<UsageBoard />);

    expect((await screen.findAllByText("internal error")).length).toBeGreaterThan(0);
  });
});
