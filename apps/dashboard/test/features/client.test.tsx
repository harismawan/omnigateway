import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientBoard } from "../../src/features/client/ClientBoard.tsx";
import { measureCharts } from "../helpers/chart.ts";
import { createFetchStub } from "../helpers/fetchStub.ts";
import {
  accountQuotaSample,
  apiKey,
  clientLog,
  headroom,
  log,
  NOW,
  usageBucket,
} from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

function stub(over: Record<string, () => unknown> = {}) {
  return createFetchStub({
    "GET /api/client/summary": () => apiKey(),
    "GET /api/client/usage": () => [usageBucket({ key: "fast" })],
    "GET /api/client/logs": () => ({ logs: [clientLog()] }),
    "GET /api/client/quota": () => ({ accounts: [] }),
    ...over,
  });
}

describe("client board", () => {
  test("reads only the client surface, never the operator's routes", async () => {
    const fetches = stub();
    renderWithProviders(<ClientBoard />);
    await screen.findByText("laptop");

    const paths = fetches.calls.map((call) => call.url.split("?")[0]);
    // The console's own routes would 401 for this session; a board that asked
    // for one would render an error the user cannot act on.
    for (const forbidden of ["/api/usage", "/api/logs", "/api/keys", "/api/credentials"]) {
      expect(paths).not.toContain(forbidden);
    }
    expect(paths.every((path) => path?.startsWith("/api/client/"))).toBe(true);
  });

  test("shows the key's own label, prefix and allowlist", async () => {
    stub();
    renderWithProviders(<ClientBoard />);

    expect(await screen.findByText("laptop")).toBeTruthy();
    expect(screen.getByText(/omni_sk_a1b2/)).toBeTruthy();
    expect(screen.getByText("Every model this gateway serves.")).toBeTruthy();
  });

  /** `null` and `[]` are opposite facts and must not render alike. */
  test("an empty allowlist reads as no models, not as every model", async () => {
    stub({ "GET /api/client/summary": () => apiKey({ modelAllowlist: [] }) });
    renderWithProviders(<ClientBoard />);

    expect(await screen.findByText("No models. This key cannot serve a request.")).toBeTruthy();
    expect(screen.queryByText("Every model this gateway serves.")).toBeNull();
  });

  test("totals come from the scoped usage the server returned", async () => {
    stub({
      "GET /api/client/usage": () => [
        usageBucket({ key: "fast", requests: 3, costUsd: 1.5, errors: 0 }),
        usageBucket({ key: "slow", requests: 4, costUsd: 2.5, errors: 1 }),
      ],
    });
    renderWithProviders(<ClientBoard />);

    expect(await screen.findByText("7")).toBeTruthy();
    expect(screen.getByText("$4.00")).toBeTruthy();
  });

  /**
   * Null is not zero.
   *
   * `concurrency` is a gauge with no stored row behind it. Rendering 0 would
   * tell a client nothing is in flight when nobody knows, which is the more
   * reassuring of the two answers and the wrong one.
   */
  test("a limit with no readable usage says unknown rather than zero", async () => {
    stub({
      "GET /api/client/summary": () => apiKey({ limits: { concurrency: 4 } }),
    });
    renderWithProviders(<ClientBoard />);

    const row = (await screen.findByText("concurrent requests")).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("unknown")).toBeTruthy();
    expect(within(row as HTMLElement).queryByText("0")).toBeNull();
  });

  test("an unreadable limit matrix is reported, not shown as unlimited", async () => {
    stub({
      "GET /api/client/summary": () => apiKey({ limits: null, limitUsage: [] }),
    });
    renderWithProviders(<ClientBoard />);

    expect(await screen.findByText("Limits unreadable")).toBeTruthy();
    expect(screen.queryByText("This key is not rate limited.")).toBeNull();
  });

  test("a key with no limits says so", async () => {
    stub({ "GET /api/client/summary": () => apiKey({ limits: {}, limitUsage: [] }) });
    renderWithProviders(<ClientBoard />);

    expect(await screen.findByText("This key is not rate limited.")).toBeTruthy();
  });

  /**
   * The disclosure this surface makes, stated as a test.
   *
   * Account names reach a key holder by the operator's decision — a screen that
   * collapsed a provider's accounts could not say which one was filling up. The
   * row renders the fraction rather than the counts because a percentage is
   * what the bar means, not because the ceiling is being kept back: it is
   * derivable, and `AccountQuota` says why that was accepted.
   */
  test("provider headroom names the account and renders a fraction", async () => {
    stub({ "GET /api/client/quota": () => ({ accounts: [headroom()] }) });
    const { container } = renderWithProviders(<ClientBoard />);

    const meter = await screen.findByRole("meter", { name: /claude-main fiveHour/ });
    const row = meter.closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("claude-main")).toBeTruthy();
    // Grouped under its provider, which is the heading rather than a column.
    expect(screen.getAllByText("anthropic").length).toBeGreaterThan(0);

    // A fraction is drawn, and printed beside the bar: the bar is the
    // comparison and the figure is the reading.
    expect(meter.getAttribute("aria-valuenow")).toBe("42");
    expect(within(row as HTMLElement).getByText("42%")).toBeTruthy();
    // What the ratio is *of* is never named. Scoped to the row, because the
    // page at large carries token counts in the thousands; the old check looked
    // for "of 1,000" across the whole container, a string no payload could
    // produce and no mutation could make appear, so it read as a disclosure
    // check while testing nothing.
    const rowText = (row as HTMLElement).textContent ?? "";
    // `formatCount` writes a ceiling with a thousands separator and the console
    // phrases the pair as "250 of 1,000", so neither shape may appear here.
    expect(rowText).not.toMatch(/\d,\d{3}/);
    expect(rowText).not.toMatch(/\bof\b/);
    expect(container.textContent).toContain("claude-main");
  });

  /**
   * Two accounts of one provider are two rows, which is the whole point of
   * naming them: the collapsed version reported one row and could not say which
   * account was the one filling up.
   */
  test("every account of a provider gets its own row under one heading", async () => {
    stub({
      "GET /api/client/quota": () => ({
        accounts: [
          headroom({ credentialId: "cred-1", label: "claude-main", usedRatio: 0.9 }),
          headroom({ credentialId: "cred-2", label: "claude-spare", usedRatio: 0.1 }),
        ],
      }),
      "GET /api/client/quota/history": () => ({ samples: [] }),
    });
    renderWithProviders(<ClientBoard />);

    expect(await screen.findByText("claude-main")).toBeTruthy();
    expect(screen.getByText("claude-spare")).toBeTruthy();
    // One heading for the provider, one control per account.
    expect(screen.getAllByRole("button", { name: /quota history/ })).toHaveLength(2);
    expect(screen.getAllByRole("meter", { name: /claude-(main|spare) fiveHour/ }).length).toBe(2);
  });

  /**
   * One row per account, its windows stacked — the accounts page's own shape.
   *
   * A five-hour window at 90% and a weekly one at 20% mean "pause for an hour";
   * the reverse means "this account is done for the week". Split across two
   * rows, that pair is two readings a reader has to join up by hand.
   */
  test("an account's windows share one row and one disclosure", async () => {
    const user = userEvent.setup();
    stub({
      "GET /api/client/quota": () => ({
        accounts: [
          headroom({ windowType: "weekly", usedRatio: 0.2 }),
          headroom({ windowType: "fiveHour", usedRatio: 0.9 }),
        ],
      }),
      "GET /api/client/quota/history": () => ({ samples: [] }),
    });
    renderWithProviders(<ClientBoard />);

    const meter = await screen.findByRole("meter", { name: /claude-main fiveHour/ });
    const row = meter.closest("tr") as HTMLElement;
    // Both windows in the same row, shortest first.
    expect(within(row).getByRole("meter", { name: /claude-main weekly/ })).toBeTruthy();
    const labels = within(row)
      .getAllByRole("meter")
      .map((node) => node.getAttribute("aria-label"));
    expect(labels[0]).toContain("fiveHour");
    expect(labels[1]).toContain("weekly");

    // And one control, opening both charts rather than one per window.
    const toggles = screen.getAllByRole("button", { name: /quota history/ });
    expect(toggles).toHaveLength(1);
    const restore = measureCharts();
    try {
      await user.click(toggles[0] as HTMLElement);
      expect(
        (await screen.findAllByText(/^\d+[hd] window$/)).map((node) => node.textContent),
      ).toEqual(["5h window", "7d window"]);
    } finally {
      restore();
    }
  });

  test("headroom with no ceiling reads unknown, not zero", async () => {
    stub({
      "GET /api/client/quota": () => ({
        accounts: [
          headroom({ provider: "openai", label: "codex", windowType: "weekly", usedRatio: null }),
        ],
      }),
    });
    renderWithProviders(<ClientBoard />);

    const row = (await screen.findByText("codex")).closest("tr");
    expect(within(row as HTMLElement).getByText("unknown")).toBeTruthy();
  });

  /**
   * Twenty rows, because that is what the panel is read for.
   *
   * The default is the fetch, not a slice of a larger one: asking for a hundred
   * and rendering twenty would make the gateway do work nobody reads.
   */
  test("the request log asks for twenty rows by default", async () => {
    const fetches = stub();
    renderWithProviders(<ClientBoard />);
    await screen.findByText("laptop");

    const logCalls = fetches.calls.filter((call) => call.url.startsWith("/api/client/logs"));
    expect(logCalls.length).toBeGreaterThan(0);
    expect(logCalls.every((call) => call.url.includes("limit=20"))).toBe(true);
  });

  test("request rows carry metadata and no way to open a body", async () => {
    const user = userEvent.setup();
    const fetches = stub();
    renderWithProviders(<ClientBoard />);
    await screen.findByText("laptop");
    // Both tables render the model name, so this waits for all of them rather
    // than asserting a uniqueness the fixtures do not have.
    expect((await screen.findAllByText("fast")).length).toBeGreaterThan(0);

    // Asserted on the request detail and on the wire, not by banning the word
    // "prompt" from the page: the usage deck legends a token class "Prompt
    // input", and a text match that broad reported a leak where there is only
    // a count. What must not exist is the affordance and the fetch.
    const row = (await screen.findAllByRole("row")).find((candidate) =>
      candidate.textContent?.includes("claude-haiku-4-5"),
    );
    if (row === undefined) throw new Error("expected a request row");
    await user.click(row);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Request id")).toBeTruthy();
    expect(within(dialog).queryByText(/request body|response body|captured/i)).toBeNull();
    expect(fetches.calls.some((call) => call.url.includes("/body"))).toBe(false);
  });

  test("an empty window says so rather than rendering an empty table", async () => {
    stub({
      "GET /api/client/usage": () => [],
      "GET /api/client/logs": () => ({ logs: [] }),
    });
    renderWithProviders(<ClientBoard />);

    expect(await screen.findByText("No traffic")).toBeTruthy();
    expect(screen.getByText("Nothing served through this key yet.")).toBeTruthy();
  });

  test("a failed read is reported per panel, not as a blank screen", async () => {
    stub({
      "GET /api/client/quota": () => ({ status: 500, body: { error: { code: "INTERNAL" } } }),
    });
    renderWithProviders(<ClientBoard />);

    // The rest of the board still renders: one dead panel must not take the
    // others with it.
    expect(await screen.findByText("Could not read provider headroom")).toBeTruthy();
    expect(screen.getByText("laptop")).toBeTruthy();
  });
});

/**
 * The client surface is on the shared primitives, not on copies of them.
 *
 * These assert the behaviour those primitives carry, which a hand-rolled table
 * and bar silently lacked: an accessible meter, and thresholds owned in one
 * place. A visual-only assertion would pass for either version, so each of
 * these is anchored on something `ui/Meter` provides and a plain `<div>` does
 * not.
 */
describe("client board uses the shared primitives", () => {
  test("a limit's consumption is an accessible meter, not a decorative bar", async () => {
    stub({
      "GET /api/client/summary": () =>
        apiKey({
          limits: { requests: { "1m": 100 } },
          limitUsage: [{ dimension: "requests", window: "1m", limit: 100, used: 25 }],
        }),
    });
    renderWithProviders(<ClientBoard />);

    const meter = await screen.findByRole("meter", { name: /requests per minute/i });
    expect(meter.getAttribute("aria-valuenow")).toBe("25");
    expect(meter.getAttribute("aria-valuemin")).toBe("0");
    expect(meter.getAttribute("aria-valuemax")).toBe("100");
  });

  test("provider headroom carries a meter naming its provider and window", async () => {
    stub({
      "GET /api/client/quota": () => ({
        accounts: [headroom({ usedRatio: 0.62, resetsAt: null })],
      }),
    });
    renderWithProviders(<ClientBoard />);

    const meter = await screen.findByRole("meter", { name: /claude-main fiveHour/i });
    expect(meter.getAttribute("aria-valuenow")).toBe("62");
  });

  test("a gauge with no reading renders no meter at all", async () => {
    stub({ "GET /api/client/summary": () => apiKey({ limits: { concurrency: 4 } }) });
    renderWithProviders(<ClientBoard />);

    await screen.findByText("concurrent requests");
    // `used` is null for a gauge. A meter at 0 would claim the key is idle,
    // which is precisely the reading nobody has.
    expect(screen.queryByRole("meter")).toBeNull();
  });

  test("a ceiling of zero reads as full rather than as unknown", async () => {
    stub({
      "GET /api/client/summary": () =>
        apiKey({
          limits: { requests: { "1m": 0 } },
          limitUsage: [{ dimension: "requests", window: "1m", limit: 0, used: 0 }],
        }),
    });
    renderWithProviders(<ClientBoard />);

    // 0/0 is not a fraction, and a limit of zero admits nothing — so the honest
    // rendering is a full bar, never a division that yields NaN.
    const meter = await screen.findByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe("100");
  });
});

/**
 * A window can overshoot its ceiling.
 *
 * Spend and tokens are debited in `finishLog` after the request served, so
 * `used > limit` is reachable rather than theoretical. The bar clamps; the
 * label did not, so a screen reader announced "150% used" over a bar drawn at
 * 100 and the two descriptions of one row disagreed.
 */
test("usage past the ceiling reads the same to a screen reader as it looks", async () => {
  stub({
    "GET /api/client/summary": () =>
      apiKey({
        limits: { requests: { "1m": 100 } },
        limitUsage: [{ dimension: "requests", window: "1m", limit: 100, used: 150 }],
      }),
  });
  renderWithProviders(<ClientBoard />);

  const meter = await screen.findByRole("meter");
  expect(meter.getAttribute("aria-valuenow")).toBe("100");
  expect(meter.getAttribute("aria-label")).toContain("100% used");
  expect(meter.getAttribute("aria-label")).not.toContain("150");

  // The overage is not hidden — it is in the figures, where it belongs.
  const row = (await screen.findByText("requests per minute")).closest("tr");
  expect(within(row as HTMLElement).getByText("150")).toBeTruthy();
});

/**
 * The client screen is the console's own instruments over one key's rows.
 *
 * Each of these is anchored on something a shared component provides and a
 * hand-rolled reduction did not, so a regression that quietly forked the two
 * surfaces fails here rather than merely looking different.
 */
describe("client board renders the console's own views", () => {
  test("requests are the operator's table minus the columns a client may not see", async () => {
    stub();
    renderWithProviders(<ClientBoard />);
    await screen.findByText("laptop");

    // From the shared table: the token breakdown carries an accessible
    // description, and the outcome is a chip rather than a bare number.
    const row = (await screen.findAllByRole("row")).find((candidate) =>
      candidate.textContent?.includes("claude-haiku-4-5"),
    );
    if (row === undefined) throw new Error("expected a request row");
    expect(within(row as HTMLElement).getByText("240ms")).toBeTruthy();
    // The breakdown's own hover text, which a plain "in + out" sum did not have.
    // Two nodes carry it — the cell and the bar inside it — so the assertion is
    // that it is there at all, not that it is unique.
    expect(within(row as HTMLElement).getAllByTitle(/1,000 in/).length).toBeGreaterThan(0);

    // The two columns that name the operator's infrastructure are absent, not
    // rendered as dashes: a dash invites "whose account was it", which is the
    // question this surface exists not to answer.
    const headers = (await screen.findAllByRole("columnheader")).map((cell) => cell.textContent);
    expect(headers).toContain("Routed to");
    expect(headers).not.toContain("Account");
    expect(headers).not.toContain("Key");
    // And the account behind the request is nowhere in the row either.
    expect(row.textContent).not.toContain("cred-1");
  });

  test("the filter reads models and errors, and never an account it cannot resolve", async () => {
    const user = userEvent.setup();
    stub({
      "GET /api/client/logs": () => ({
        logs: [
          log({ id: "req-ok", requestedModel: "fast" }),
          log({ id: "req-bad", requestedModel: "slow", status: 502, errorCode: "UPSTREAM" }),
        ],
      }),
    });
    renderWithProviders(<ClientBoard />);
    await screen.findByText("laptop");

    await user.type(screen.getByLabelText("Filter requests"), "slow");
    await waitFor(() => {
      expect(screen.queryByText("UPSTREAM")).toBeTruthy();
    });
    const rows = screen.getAllByRole("row").filter((row) => row.textContent?.includes("ms"));
    expect(rows).toHaveLength(1);
  });

  test("the deck reports every class the usage board does, from one scoped read", async () => {
    const fetches = stub({
      "GET /api/client/usage": () => [
        usageBucket({ key: "fast", requests: 4, inputTokens: 1_000, cacheReadTokens: 500 }),
      ],
    });
    renderWithProviders(<ClientBoard />);
    await screen.findByText("laptop");

    // The classes a bare four-card summary did not report at all.
    for (const legend of [
      "Prompt input",
      "Cache reads",
      "Cache writes",
      "RTK saved",
      "Error rate",
    ]) {
      expect(screen.getByText(legend)).toBeTruthy();
    }
    // Still only this key's own surface, whatever the deck asks for.
    expect(
      fetches.calls.every((call) => (call.url.split("?")[0] ?? "").startsWith("/api/client/")),
    ).toBe(true);
  });

  /**
   * The chart is fetched only while a row is open.
   *
   * The history read folds every retained reading in the span, so a panel that
   * loaded it on arrival would pay for a chart nobody asked to see — the same
   * reason the operator's disclosure is lazy.
   */
  test("provider headroom charts its history, and only once a row is expanded", async () => {
    const user = userEvent.setup();
    const fetches = stub({
      "GET /api/client/quota": () => ({
        accounts: [headroom({ usedRatio: 0.4 })],
      }),
      "GET /api/client/quota/history": () => ({
        samples: [
          accountQuotaSample({ observedAt: NOW - 3_600_000, usedRatio: 0.2 }),
          accountQuotaSample({ observedAt: NOW - 60_000, usedRatio: 0.4 }),
        ],
      }),
    });
    const restore = measureCharts();
    try {
      renderWithProviders(<ClientBoard />);
      const toggle = await screen.findByRole("button", {
        name: "Show quota history for claude-main",
      });
      expect(fetches.calls.some((call) => call.url.startsWith("/api/client/quota/history"))).toBe(
        false,
      );

      await user.click(toggle);
      await waitFor(() => {
        expect(fetches.calls.some((call) => call.url.startsWith("/api/client/quota/history"))).toBe(
          true,
        );
      });

      // The shared chart's own facts row, drawn from the readings.
      expect(await screen.findByText("Window average")).toBeTruthy();
      // A percentage per hour, never the provider's units: the ceiling those
      // would be counted against is the operator's account.
      expect(screen.getByText("10.0%/h")).toBeTruthy();
    } finally {
      restore();
    }
  });

  test("a rolled-over window keeps its measured readings and drops only the inferences", async () => {
    const user = userEvent.setup();
    stub({
      "GET /api/client/quota": () => ({
        accounts: [
          headroom({
            usedRatio: 0.4,
            // Its own reset is behind us; the reading itself is a minute old.
            resetsAt: NOW - 3_600_000,
            observedAt: NOW - 60_000,
            ratePerHourRatio: null,
            exhaustsAt: null,
            survives: null,
            rolledOver: true,
          }),
        ],
      }),
      "GET /api/client/quota/history": () => ({ samples: [] }),
    });
    const restore = measureCharts();
    try {
      renderWithProviders(<ClientBoard />);
      await user.click(
        await screen.findByRole("button", { name: "Show quota history for claude-main" }),
      );

      // Said in both places it is read — the row's legend and the chart's own
      // note — rather than blanked: the panel is not stale, and blanking it
      // would throw away real history for up to a poll interval after every
      // rollover.
      expect((await screen.findAllByText(/rolled over/)).length).toBeGreaterThan(1);
      expect(screen.queryByText("reading is stale")).toBeNull();
    } finally {
      restore();
    }
  });

  test("a stale reading says so instead of charting from it", async () => {
    const user = userEvent.setup();
    stub({
      "GET /api/client/quota": () => ({
        accounts: [
          headroom({
            usedRatio: 0.4,
            observedAt: NOW - 6 * 3_600_000,
            ratePerHourRatio: null,
            exhaustsAt: null,
            survives: null,
            stale: true,
          }),
        ],
      }),
      "GET /api/client/quota/history": () => ({ samples: [] }),
    });
    const restore = measureCharts();
    try {
      renderWithProviders(<ClientBoard />);
      await user.click(
        await screen.findByRole("button", { name: "Show quota history for claude-main" }),
      );

      expect(await screen.findByText("reading is stale")).toBeTruthy();
      expect(screen.queryByText("Window average")).toBeNull();
    } finally {
      restore();
    }
  });
});
