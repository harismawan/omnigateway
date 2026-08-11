import { describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { OverviewBoard } from "../../src/features/overview/OverviewBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { credential, health, log, model, quota, usageBucket } from "../helpers/fixtures.ts";
import { renderWithRouter } from "../helpers/render.tsx";

/** Logs are placed relative to the real clock, since the board reads Date.now(). */
function recentLogs(now = Date.now()) {
  return [
    log({ id: "a", at: now - 30_000, ttftMs: 200 }),
    log({ id: "b", at: now - 60_000, ttftMs: 400 }),
    log({
      id: "c",
      at: now - 90_000,
      status: 502,
      errorCode: "UPSTREAM",
      ttftMs: null,
      costUsd: 0,
    }),
  ];
}

function stubOverview(overrides: Parameters<typeof createFetchStub>[0] = {}) {
  return createFetchStub({
    "GET /api/credentials": () => ({
      credentials: [credential(), credential({ id: "cred-2", provider: "openai", label: "codex" })],
    }),
    "GET /api/credentials/health": () => ({
      health: [health(), health({ credentialId: "cred-2", model: "gpt-5.6" })],
      quota: [quota()],
    }),
    "GET /api/models": () => ({ models: [model()] }),
    "GET /api/logs": () => ({ logs: recentLogs() }),
    "GET /api/usage": () => ({ rows: [usageBucket()] }),
    ...overrides,
  });
}

describe("OverviewBoard", () => {
  test("says nothing needs attention when every account answers", async () => {
    stubOverview();
    renderWithRouter(<OverviewBoard />);

    expect(
      await screen.findByText("All 2 accounts are answering. Nothing needs attention."),
    ).toBeTruthy();
  });

  test("uses the same progress-bar width for every quota window", async () => {
    const now = Date.now();
    stubOverview({
      "GET /api/credentials/health": () => ({
        health: [health()],
        quota: [
          quota({ windowType: "fiveHour", resetsAt: now + 12 * 60_000 }),
          quota({ windowType: "weekly", resetsAt: now + 2 * 86_400_000 }),
        ],
      }),
    });
    renderWithRouter(<OverviewBoard />);

    const fiveHour = await screen.findByLabelText(/5h window/);
    const weekly = screen.getByLabelText(/7d window/);

    expect(getComputedStyle(fiveHour.parentElement as HTMLElement).gridTemplateColumns).toBe(
      "72px 1fr",
    );
    expect(getComputedStyle(weekly.parentElement as HTMLElement).gridTemplateColumns).toBe(
      "72px 1fr",
    );
  });

  test("names the number of accounts out of rotation", async () => {
    stubOverview({
      "GET /api/credentials/health": () => ({
        health: [health({ breakerState: "open", consecutiveFailures: 5 })],
        quota: [],
      }),
    });
    renderWithRouter(<OverviewBoard />);

    expect(await screen.findByText("1 account is out of rotation.")).toBeTruthy();
  });

  test("reads the vitals off the request log", async () => {
    stubOverview();
    renderWithRouter(<OverviewBoard />);

    expect(await screen.findByText("Requests")).toBeTruthy();
    expect(screen.getByText("33.3%")).toBeTruthy();
    expect(screen.getByText("1 failed")).toBeTruthy();
    // p50 of 200ms and 400ms, with the failed request contributing no latency.
    expect(screen.getByText("200ms")).toBeTruthy();
  });

  test("counts every token class in the one-hour total and sparkline", async () => {
    const now = Date.now();
    stubOverview({
      "GET /api/logs": () => ({
        logs: [
          log({
            id: "tokens",
            at: now - 30_000,
            inputTokens: 1_000,
            outputTokens: 200,
            cacheReadTokens: 3_000,
            cacheWriteTokens: 400,
          }),
          log({
            id: "old",
            at: now - 3_700_000,
            inputTokens: 90_000,
            outputTokens: 90_000,
            cacheReadTokens: 90_000,
            cacheWriteTokens: 90_000,
          }),
        ],
      }),
    });
    renderWithRouter(<OverviewBoard />);

    expect(await screen.findByText("Total tokens")).toBeTruthy();
    expect(screen.getByText("4,600")).toBeTruthy();
    const tokenLabel = "1,000 input, 200 output, 3,000 cache read, 400 cache write tokens";
    const tokenCard = screen.getByText("Total tokens").parentElement;
    if (tokenCard === null) throw new Error("Total tokens card was not rendered");
    expect(within(tokenCard).getByRole("img", { name: tokenLabel })).toBeTruthy();
    expect(screen.getByLabelText("token volume over the window, 4,600 total")).toBeTruthy();

    const cardLabels = ["Requests", "Error rate", "Total tokens", "Time to first token", "Spend"];
    const deck = tokenCard?.parentElement;
    const cards = cardLabels.map((label) =>
      screen.getAllByText(label).find((match) => match.parentElement?.parentElement === deck),
    );
    expect(cards.every((card) => card !== undefined)).toBe(true);
    expect(cards.map((card) => card?.parentElement)).toEqual(
      Array.from(deck?.children ?? []).filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      ),
    );
  });

  test("shows token detail for completed activity and processing for pending activity", async () => {
    const now = Date.now();
    stubOverview({
      "GET /api/logs": () => ({
        logs: [
          log({
            id: "pending",
            state: "pending",
            at: now - 2_000,
            durationMs: 0,
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
          }),
          log({
            id: "done",
            at: now - 30_000,
            durationMs: 1_400,
            costUsd: 0.012,
            inputTokens: 1_200,
            outputTokens: 340,
            cacheReadTokens: 8_400,
            cacheWriteTokens: 120,
          }),
        ],
      }),
    });
    renderWithRouter(<OverviewBoard />);

    const tokenLabel = "1,200 input, 340 output, 8,400 cache read, 120 cache write tokens";
    await screen.findByText("Activity");
    const activity = screen.getByText("Activity").closest("section");
    const completedTokens = activity?.querySelector(`[aria-label="${tokenLabel}"]`);
    expect(completedTokens).toBeTruthy();
    expect(completedTokens?.getAttribute("title")).toBe(tokenLabel);
    expect(completedTokens?.textContent).toBe("1,2003408,400120");

    const processing = screen.getByLabelText("processing");
    expect(processing.textContent).toBe("processing...");
    const pendingRow = processing.closest("li");
    expect(pendingRow?.textContent).not.toContain("$0.00");
    expect(pendingRow?.textContent).not.toContain("0ms");
  });

  test("an unconfigured gateway is called out rather than shown as healthy", async () => {
    stubOverview({
      "GET /api/credentials": () => ({ credentials: [] }),
      "GET /api/credentials/health": () => ({ health: [], quota: [] }),
    });
    renderWithRouter(<OverviewBoard />);

    expect(
      await screen.findByText("No accounts are connected, so every request fails at the router."),
    ).toBeTruthy();
  });

  test("an unreachable gateway replaces the readouts with the failure", async () => {
    stubOverview({
      "GET /api/logs": () => ({
        status: 500,
        body: { error: { code: "INTERNAL", message: "internal error" } },
      }),
    });
    renderWithRouter(<OverviewBoard />);

    expect(await screen.findByText("The gateway did not answer")).toBeTruthy();
    expect(screen.getByText("internal error")).toBeTruthy();
  });

  test("the activity tail shows the most recent requests first", async () => {
    stubOverview();
    renderWithRouter(<OverviewBoard />);

    expect(await screen.findByText("Activity")).toBeTruthy();
    expect(screen.getByText("UPSTREAM")).toBeTruthy();
  });
});
