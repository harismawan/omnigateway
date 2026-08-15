import { describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import type { Credential } from "../../src/api/types.ts";
import { OverviewBoard } from "../../src/features/overview/OverviewBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { burn, credential, health, log, model, quota, usageBucket } from "../helpers/fixtures.ts";
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

  test("keeps a large token breakdown inside its card instead of overflowing it", async () => {
    const now = Date.now();
    createFetchStub({
      "GET /api/logs": () => ({
        // A window where cache reads dwarf everything else, which is what pushes
        // the breakdown past the width of a 168px card column.
        logs: [
          log({
            id: "busy",
            at: now - 1_000,
            inputTokens: 2_485,
            outputTokens: 90_000,
            cacheReadTokens: 25_600_000,
            cacheWriteTokens: 668_200,
          }),
        ],
      }),
    });
    renderWithRouter(<OverviewBoard />);

    await screen.findByText("Total tokens");
    const label = "2,485 input, 90,000 output, 25,600,000 cache read, 668,200 cache write tokens";
    // The same log also draws a breakdown in the activity tail, so the card is
    // what this assertion is about, not the first match on the page.
    const tokenCard = screen.getByText("Total tokens").parentElement;
    if (tokenCard === null) throw new Error("Total tokens card was not rendered");
    const breakdown = within(tokenCard).getByRole("img", { name: label });
    const valueRow = breakdown.parentElement?.parentElement;
    if (valueRow === null || valueRow === undefined) throw new Error("breakdown has no value row");

    // Neither the number nor the breakdown can shrink, so the only thing that
    // keeps them inside the card is being allowed onto a second line.
    expect(getComputedStyle(valueRow).flexWrap).toBe("wrap");
    expect(getComputedStyle(breakdown).flexWrap).toBe("wrap");
    // A count still never splits away from the arrow that names it.
    expect(getComputedStyle(breakdown).whiteSpace).toBe("nowrap");
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

  test("the rack names the window an account will not survive", async () => {
    const now = Date.now();
    stubOverview({
      "GET /api/credentials/health": () => ({
        health: [health()],
        quota: [quota({ observedAt: now - 30_000, resetsAt: now + 3_600_000 })],
        burn: [
          burn({
            windowStartsAt: now - 3_600_000,
            exhaustsAt: now + 1_800_000,
            survives: false,
          }),
        ],
      }),
    });
    renderWithRouter(<OverviewBoard />);

    // Matched by shape: the board reads its own Date.now() after the stub.
    expect(await screen.findByText(/^5h · empty ~\d+m · resets in \d+[mh]$/)).toBeTruthy();
  });

  test("the rack stays one line per account: no chart, no disclosure, no extra column", async () => {
    const now = Date.now();
    stubOverview({
      "GET /api/credentials/health": () => ({
        health: [health()],
        quota: [quota({ observedAt: now - 30_000, resetsAt: now + 3_600_000 })],
        burn: [burn({ windowStartsAt: now - 3_600_000, exhaustsAt: now + 1_800_000 })],
      }),
    });
    const { container } = renderWithRouter(<OverviewBoard />);

    const table = (await screen.findByText("claude-main")).closest("table");
    if (table === null) throw new Error("the account rack was not rendered");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Account", "Provider", "Tier", "Quota", "TTFT", "Requests", "Last used"]);
    expect(within(table).queryByRole("button", { name: /quota history/i })).toBeNull();
    expect(container.querySelector(".recharts-responsive-container")).toBeNull();
  });

  describe("the rack's order", () => {
    // Burn rate is now a sort key, between lamp state and tier. These tests
    // replace an earlier one that pinned the opposite — see the design note in
    // `docs/superpowers/specs/2026-08-15-provider-quota-telemetry-design.md`.

    /** Row labels in document order, which is the order the rack drew them. */
    async function rackOrder(): Promise<(string | null)[]> {
      // The rack draws its rows as soon as the credentials query lands, which
      // can be before the health query carrying the estimates. A legend only
      // health can produce is what makes this read the sorted order rather
      // than the order the credentials arrived in.
      const legend = await screen.findAllByText(/^5h · /);
      const table = legend[0]?.closest("table") ?? null;
      if (table === null) throw new Error("the account rack was not rendered");
      return within(table)
        .getAllByText(/^(claude-main|codex)$/)
        .map((node) => node.textContent);
    }

    /** Two healthy accounts, tier 1 first, so only the burn key can part them. */
    function twoAccounts(burns: ReturnType<typeof burn>[], patch: Partial<Credential>[] = []) {
      const now = Date.now();
      return stubOverview({
        "GET /api/credentials": () => ({
          credentials: [
            credential({ tier: 1, ...patch[0] }),
            credential({
              id: "cred-2",
              provider: "openai",
              label: "codex",
              tier: 2,
              ...patch[1],
            }),
          ],
        }),
        "GET /api/credentials/health": () => ({
          health: [health(), health({ credentialId: "cred-2", model: "gpt-5.6" })],
          quota: [
            quota({ observedAt: now - 30_000, resetsAt: now + 3_600_000 }),
            quota({
              credentialId: "cred-2",
              used: 100,
              observedAt: now - 30_000,
              resetsAt: now + 3_600_000,
            }),
          ],
          burn: burns,
        }),
      });
    }

    test("puts an account that will not survive its window above a healthier one", async () => {
      const now = Date.now();
      twoAccounts([
        burn({ windowStartsAt: now - 3_600_000, ratePerHour: 1, exhaustsAt: null, survives: true }),
        burn({
          credentialId: "cred-2",
          windowStartsAt: now - 3_600_000,
          ratePerHour: 9_000,
          exhaustsAt: now + 60_000,
          survives: false,
        }),
      ]);
      renderWithRouter(<OverviewBoard />);

      // Tier order says claude-main first; the window codex will not survive
      // outranks it.
      expect(await rackOrder()).toEqual(["codex", "claude-main"]);
    });

    test("puts the sooner exhaustion first when neither account survives", async () => {
      const now = Date.now();
      twoAccounts([
        burn({
          windowStartsAt: now - 3_600_000,
          ratePerHour: 900,
          exhaustsAt: now + 1_800_000,
          survives: false,
        }),
        burn({
          credentialId: "cred-2",
          windowStartsAt: now - 3_600_000,
          ratePerHour: 9_000,
          exhaustsAt: now + 60_000,
          survives: false,
        }),
      ]);
      renderWithRouter(<OverviewBoard />);

      expect(await rackOrder()).toEqual(["codex", "claude-main"]);
    });

    test("keeps a down account above a fast-burning healthy one", async () => {
      const now = Date.now();
      stubOverview({
        "GET /api/credentials": () => ({
          credentials: [
            // Worst tier, so nothing but the lamp can hold it at the top.
            credential({ tier: 9 }),
            credential({ id: "cred-2", provider: "openai", label: "codex", tier: 1 }),
          ],
        }),
        "GET /api/credentials/health": () => ({
          health: [
            health({ breakerState: "open", consecutiveFailures: 5 }),
            health({ credentialId: "cred-2", model: "gpt-5.6" }),
          ],
          quota: [
            quota({
              credentialId: "cred-2",
              used: 100,
              observedAt: now - 30_000,
              resetsAt: now + 3_600_000,
            }),
          ],
          burn: [
            burn({
              credentialId: "cred-2",
              windowStartsAt: now - 3_600_000,
              ratePerHour: 9_000,
              exhaustsAt: now + 60_000,
              survives: false,
            }),
          ],
        }),
      });
      renderWithRouter(<OverviewBoard />);

      expect(await rackOrder()).toEqual(["claude-main", "codex"]);
    });

    test("does not let a suppressed estimate promote an account", async () => {
      const now = Date.now();
      // Both shapes of suppression: the nulled estimate control actually
      // returns, and a stale flag over figures that survived on the row.
      // Losing sight of an account is not the same as an account draining.
      twoAccounts([
        burn({
          windowStartsAt: null,
          ratePerHour: null,
          exhaustsAt: null,
          survives: null,
          stale: true,
        }),
        burn({
          credentialId: "cred-2",
          windowStartsAt: now - 3_600_000,
          ratePerHour: 9_000,
          exhaustsAt: now + 60_000,
          survives: false,
          stale: true,
        }),
      ]);
      renderWithRouter(<OverviewBoard />);

      expect(await rackOrder()).toEqual(["claude-main", "codex"]);
    });

    test("falls back to tier order when no account reports burn at all", async () => {
      twoAccounts([]);
      renderWithRouter(<OverviewBoard />);

      expect(await rackOrder()).toEqual(["claude-main", "codex"]);
    });

    test("leaves accounts that exhaust at the same instant in the order given", async () => {
      const now = Date.now();
      const same = { windowStartsAt: now - 3_600_000, exhaustsAt: now + 60_000, survives: false };
      twoAccounts(
        [burn(same), burn({ credentialId: "cred-2", ...same })],
        // Same tier as well, so the comparator has nothing left to decide on.
        [{ tier: 3 }, { tier: 3 }],
      );
      renderWithRouter(<OverviewBoard />);

      expect(await rackOrder()).toEqual(["claude-main", "codex"]);
    });
  });
});
