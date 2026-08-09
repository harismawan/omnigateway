import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageBoard } from "../../src/features/usage/UsageBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { apiKey, credential, model, usageBucket } from "../helpers/fixtures.ts";
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
  if (url.includes("splitBy=model")) {
    return {
      rows: [
        usageBucket({
          key: THIS_HOUR,
          split: "claude-haiku-4-5",
          requests: 30,
          inputTokens: 300_000,
          outputTokens: 40_000,
          costUsd: 2,
        }),
        usageBucket({
          key: THIS_HOUR,
          split: "gpt-5-codex",
          requests: 8,
          inputTokens: 60_000,
          outputTokens: 20_000,
          costUsd: 0.5,
        }),
        usageBucket({
          key: THIS_HOUR,
          split: "unknown",
          requests: 2,
          inputTokens: 4_000,
          outputTokens: 1_000,
          errors: 2,
          costUsd: 0,
        }),
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
    "GET /api/models": () => ({ models: [model()] }),
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
    // Future days in the current week are deliberately hidden from the
    // accessibility tree, but still occupy cells so the 53-week shape holds.
    expect(grid.querySelectorAll('[role="gridcell"]')).toHaveLength(371);

    const today = new Date(TODAY).toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    expect(screen.getByLabelText(`${today}: 40 requests, 150k tokens, $2.00`)).toBeTruthy();
  });

  test("the activity grid reads the whole year when no day is hovered", async () => {
    const user = userEvent.setup();
    stubUsage();
    renderWithProviders(<UsageBoard />);
    await screen.findByRole("grid", { name: "Tokens per day over the last year" });

    // 40 + 4 requests, two days of the fixture's 150k tokens, $2.00 + $0.20.
    expect(screen.getByText("Last 12 months: 44 requests, 300k tokens, $2.20")).toBeTruthy();
    expect(screen.getByText("2 active days")).toBeTruthy();

    // Hovering a day swaps the subject, not the shape of the reading.
    const today = new Date(TODAY).toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    await user.hover(screen.getByLabelText(`${today}: 40 requests, 150k tokens, $2.00`));
    expect(await screen.findByText(`${today}: 40 requests, 150k tokens, $2.00`)).toBeTruthy();

    await user.unhover(screen.getByLabelText(`${today}: 40 requests, 150k tokens, $2.00`));
    expect(await screen.findByText("Last 12 months: 44 requests, 300k tokens, $2.20")).toBeTruthy();
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

  test("cuts the traffic trace by the upstream model that served it", async () => {
    const stub = stubUsage();
    renderWithProviders(<UsageBoard />);

    expect(await screen.findByText("Traffic by upstream model")).toBeTruthy();
    // Tokens is the default lens, and the header says which one is painting it.
    expect(screen.getByText("Tokens, by hour")).toBeTruthy();
    // Named in the legend, because a band is never identified by colour alone.
    expect(screen.getByText("claude-haiku-4-5")).toBeTruthy();
    expect(screen.getByText("gpt-5-codex")).toBeTruthy();
    // Traffic the gateway never resolved to a model is still a band.
    expect(screen.getByText("Unresolved")).toBeTruthy();

    await waitFor(() => {
      expect(
        stub.calls.some(
          (call) => call.url.includes("groupBy=hour") && call.url.includes("splitBy=model"),
        ),
      ).toBe(true);
    });
  });

  test("the model stack follows the shared ranking lens", async () => {
    const user = userEvent.setup();
    stubUsage();
    renderWithProviders(<UsageBoard />);
    await screen.findByText("Tokens, by hour");

    await user.click(screen.getByRole("button", { name: "Rank by cost" }));

    expect(await screen.findByText("Cost, by hour")).toBeTruthy();
  });

  test("folds the tail of a long model list into one band", async () => {
    createFetchStub({
      "GET /api/usage": ({ url }) =>
        url.includes("splitBy=model")
          ? {
              rows: Array.from({ length: 9 }, (_, index) =>
                usageBucket({
                  key: THIS_HOUR,
                  split: `model-${index}`,
                  inputTokens: (9 - index) * 1_000,
                  outputTokens: 0,
                }),
              ),
            }
          : rowsFor(url),
      "GET /api/credentials": () => ({ credentials: [credential()] }),
      "GET /api/keys": () => ({ keys: [apiKey()] }),
      "GET /api/models": () => ({ models: [model()] }),
    });
    renderWithProviders(<UsageBoard />);

    // Six bands are drawn; the three quietest are counted, not hidden.
    expect(await screen.findByText("model-0")).toBeTruthy();
    expect(screen.getByText("model-5")).toBeTruthy();
    expect(screen.queryByText("model-6")).toBeNull();
    expect(screen.getByText("3 more")).toBeTruthy();
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
    // Future days remain hidden from the accessibility tree.
    const grid = screen.getByRole("grid", { name: "Tokens per day over the last year" });
    expect(grid.querySelectorAll('[role="gridcell"]')).toHaveLength(371);
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
