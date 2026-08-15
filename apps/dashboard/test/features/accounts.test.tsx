import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BurnEstimate, QuotaSample, QuotaWindow } from "../../src/api/types.ts";
import { AccountsBoard } from "../../src/features/accounts/AccountsBoard.tsx";
import { PACE_DASH } from "../../src/features/accounts/QuotaHistory.tsx";
import { axisTicks, dashedPaths, measureCharts, vertices } from "../helpers/chart.ts";
import { createFetchStub } from "../helpers/fetchStub.ts";
import {
  burn,
  credential,
  health,
  NOW,
  quota,
  quotaSample,
  settings,
} from "../helpers/fixtures.ts";
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

  test("gives every quota window the same wider bar track", async () => {
    stubAccounts({
      "GET /api/credentials/health": () => ({
        health: [health()],
        quota: [
          quota({ windowType: "fiveHour", used: 950, limit: 1_000 }),
          quota({ windowType: "weekly", used: 200, limit: 1_000 }),
        ],
      }),
    });
    renderWithProviders(<AccountsBoard />);

    const fiveHour = await screen.findByLabelText("5h window, 95% used");
    const weekly = screen.getByLabelText("7d window, 20% used");
    const quotaHeader = screen.getAllByRole("columnheader", { name: "Quota" })[0];

    expect(getComputedStyle(quotaHeader as HTMLElement).width).toBe("240px");
    expect(getComputedStyle(fiveHour.parentElement as HTMLElement).gridTemplateColumns).toBe(
      "96px 1fr",
    );
    expect(getComputedStyle(weekly.parentElement as HTMLElement).gridTemplateColumns).toBe(
      "96px 1fr",
    );
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

  test("keeps the selected existing custom endpoint visible", async () => {
    const user = userEvent.setup();
    stubAccounts({
      "GET /api/credentials": () => ({
        credentials: [
          credential({
            id: "custom-1",
            provider: "custom",
            providerData: {
              endpointId: "local-vllm",
              endpointLabel: "Local vLLM",
              origin: "http://localhost:8000",
              protocol: "chat_completions",
            },
          }),
        ],
      }),
    });
    renderWithProviders(<AccountsBoard />);

    await user.click(
      (await screen.findAllByRole("button", { name: "Connect an account" }))[0] as HTMLElement,
    );
    await user.selectOptions(screen.getByLabelText("Provider"), "custom");
    const endpoint = screen.getByLabelText("Existing endpoint") as HTMLSelectElement;
    await user.selectOptions(endpoint, "local-vllm");

    expect(endpoint.value).toBe("local-vllm");
    expect(endpoint.selectedOptions[0]?.textContent).toBe("Local vLLM");
  });

  test("returns to a blank endpoint form after reselecting create new endpoint", async () => {
    const user = userEvent.setup();
    stubAccounts({
      "GET /api/credentials": () => ({
        credentials: [
          credential({
            id: "custom-1",
            provider: "custom",
            providerData: {
              endpointId: "local-vllm",
              endpointLabel: "Local vLLM",
              origin: "http://localhost:8000",
              protocol: "chat_completions",
            },
          }),
        ],
      }),
    });
    renderWithProviders(<AccountsBoard />);

    await user.click(
      (await screen.findAllByRole("button", { name: "Connect an account" }))[0] as HTMLElement,
    );
    await user.selectOptions(screen.getByLabelText("Provider"), "custom");
    const endpoint = screen.getByLabelText("Existing endpoint") as HTMLSelectElement;
    await user.selectOptions(endpoint, "local-vllm");
    await user.selectOptions(endpoint, "");

    expect(endpoint.value).toBe("");
    expect((screen.getByLabelText("Endpoint ID") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Endpoint label") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Server origin") as HTMLInputElement).value).toBe("");
  });

  test("names the upstream path each protocol calls", async () => {
    const user = userEvent.setup();
    stubAccounts({});
    renderWithProviders(<AccountsBoard />);

    await user.click(
      (await screen.findAllByRole("button", { name: "Connect an account" }))[0] as HTMLElement,
    );
    await user.selectOptions(screen.getByLabelText("Provider"), "custom");

    const protocol = screen.getByLabelText("Protocol") as HTMLSelectElement;
    expect(
      within(protocol).getByRole("option", { name: "Chat Completions (/v1/chat/completions)" }),
    ).toBeTruthy();
    expect(
      within(protocol).getByRole("option", { name: "Responses (/v1/responses)" }),
    ).toBeTruthy();
  });

  test("creates an OpenAI-compatible credential and warns for HTTP", async () => {
    const user = userEvent.setup();
    const stub = stubAccounts({ "POST /api/credentials": () => ({ credential: credential() }) });
    renderWithProviders(<AccountsBoard />);

    await user.click(
      (await screen.findAllByRole("button", { name: "Connect an account" }))[0] as HTMLElement,
    );
    await user.selectOptions(screen.getByLabelText("Provider"), "custom");
    await user.type(screen.getByLabelText("Endpoint ID"), "local-vllm");
    await user.type(screen.getByLabelText("Endpoint label"), "Local vLLM");
    await user.type(screen.getByLabelText("Server origin"), "http://localhost:8000");
    await user.selectOptions(screen.getByLabelText("Protocol"), "chat_completions");
    await user.type(screen.getByLabelText("API key"), "test-provider-key");

    expect(screen.getByText(/plaintext transport/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add API key" }));
    await waitFor(() => {
      const call = stub.calls.find(
        (entry) => entry.url === "/api/credentials" && entry.init?.method === "POST",
      );
      expect(call?.init?.body as string).toContain('"endpointId":"local-vllm"');
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

/**
 * A five-hour window that started an hour ago, read half a minute ago. Built
 * against the real clock because the board reads its own `Date.now()`.
 */
function liveWindow(now: number) {
  return {
    quota: quota({
      used: 500,
      limit: 1_000,
      observedAt: now - 30_000,
      resetsAt: now + 4 * 3_600_000,
    }),
    burn: burn({
      windowStartsAt: now - 3_600_000,
      ratePerHour: 500,
      exhaustsAt: now + 1_800_000,
      survives: false,
    }),
  };
}

describe("AccountsBoard quota history", () => {
  /** The gateway rate rides the history response, not the ten-second health poll. */
  const gatewayRates = [
    { credentialId: "cred-1", windowType: "fiveHour", gatewayRatePerHour: 120_000 },
  ];

  function stubHistory(samples: unknown[], now = Date.now()) {
    const live = liveWindow(now);
    return stubAccounts({
      "GET /api/credentials/health": () => ({
        health: [health()],
        quota: [live.quota],
        burn: [live.burn],
      }),
      "GET /api/credentials/quota/history": () => ({ samples, gatewayRates }),
    });
  }

  test("a row opens and closes its history by name, and reads nothing until it does", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    const stub = stubHistory([
      quotaSample({ observedAt: now - 3_000_000, used: 100, resetsAt: now + 4 * 3_600_000 }),
      quotaSample({ observedAt: now - 600_000, used: 400, resetsAt: now + 4 * 3_600_000 }),
    ]);
    renderWithProviders(<AccountsBoard />);

    const open = await screen.findByRole("button", { name: "Show quota history for claude-main" });
    expect(stub.calls.some((call) => call.url.startsWith("/api/credentials/quota/history"))).toBe(
      false,
    );

    await user.click(open);
    expect(await screen.findByText("Window average")).toBeTruthy();
    await waitFor(() => {
      expect(stub.calls.some((call) => call.url.startsWith("/api/credentials/quota/history"))).toBe(
        true,
      );
    });

    await user.click(screen.getByRole("button", { name: "Hide quota history for claude-main" }));
    expect(screen.queryByText("Window average")).toBeNull();
  });

  test("names the rate as a window average, the estimate, and what the gateway accounts for", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    stubHistory([quotaSample({ observedAt: now - 600_000, used: 400 })], now);
    renderWithProviders(<AccountsBoard />);

    await user.click(
      await screen.findByRole("button", { name: "Show quota history for claude-main" }),
    );

    expect(await screen.findByText("Window average")).toBeTruthy();
    expect(screen.getByText("500/h")).toBeTruthy();
    expect(screen.getByText(/^empty ~\d+m before it resets$/)).toBeTruthy();
    expect(screen.getByText("This gateway accounts for")).toBeTruthy();
    expect(screen.getByText("120k tokens/h")).toBeTruthy();
  });

  test("holds each reading until the next one instead of sloping between them", async () => {
    // Readings are stored only when something moved, so a flat stretch in the
    // data is a flat stretch in reality; interpolating would draw a climb that
    // never happened.
    const restore = measureCharts();
    try {
      const user = userEvent.setup();
      const now = Date.now();
      const resetsAt = now + 4 * 3_600_000;
      stubHistory(
        [
          quotaSample({ observedAt: now - 3_000_000, used: 100, resetsAt }),
          quotaSample({ observedAt: now - 2_000_000, used: 100, resetsAt }),
          quotaSample({ observedAt: now - 600_000, used: 400, resetsAt }),
        ],
        now,
      );
      const { container } = renderWithProviders(<AccountsBoard />);

      await user.click(
        await screen.findByRole("button", { name: "Show quota history for claude-main" }),
      );
      await screen.findByText("Window average");

      // Solid lines only: the dashed overlays are drawn pace, not readings.
      await waitFor(() => expect(dashedPaths(container, null)).toHaveLength(1));
      const drawn = dashedPaths(container, null)[0] ?? "";
      expect(drawn).not.toContain("C");
      const corners = vertices(drawn);
      expect(corners.length).toBeGreaterThan(3);
      for (const [index, corner] of corners.entries()) {
        const previous = corners[index - 1];
        if (previous === undefined) continue;
        // Every segment is flat or a vertical step; nothing runs diagonally.
        expect(previous[0] === corner[0] || previous[1] === corner[1]).toBe(true);
      }
    } finally {
      restore();
    }
  });

  test("breaks the line at a rollover rather than dropping it to the floor", async () => {
    const restore = measureCharts();
    try {
      const user = userEvent.setup();
      const now = Date.now();
      const resetsAt = now + 4 * 3_600_000;
      const previous = resetsAt - 5 * 3_600_000;
      stubHistory(
        [
          quotaSample({ observedAt: previous - 3_600_000, used: 400, resetsAt: previous }),
          quotaSample({ observedAt: previous - 600_000, used: 900, resetsAt: previous }),
          quotaSample({ observedAt: previous + 600_000, used: 20, resetsAt }),
          quotaSample({ observedAt: now - 600_000, used: 80, resetsAt }),
        ],
        now,
      );
      const { container } = renderWithProviders(<AccountsBoard />);

      await user.click(
        await screen.findByRole("button", { name: "Show quota history for claude-main" }),
      );
      await screen.findByText("Window average");

      // One series per window: nothing joins the end of one to the start of
      // the next, so the rollover is a break rather than a cliff.
      await waitFor(() => expect(dashedPaths(container, null)).toHaveLength(2));
      const [first, second] = dashedPaths(container, null).map((d) =>
        vertices(d).map(([, y]) => y),
      );
      if (first === undefined || second === undefined) throw new Error("both windows draw a line");
      // Y grows downward, so the spent window stays above the fresh one.
      expect(Math.max(...first)).toBeLessThan(Math.min(...second));
    } finally {
      restore();
    }
  });

  test("an account the provider reports nothing for offers no history to open", async () => {
    stubAccounts({
      "GET /api/credentials/health": () => ({ health: [health()], quota: [], burn: [] }),
    });
    renderWithProviders(<AccountsBoard />);

    expect(await screen.findAllByText("unknown")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /quota history/i })).toBeNull();
  });

  test("asks for the current window and the one before it, not the whole retention window", async () => {
    // The chart's range is the range in which the estimate means anything. A
    // five-hour window drawn over thirty days is noise, and asking for thirty
    // days of samples to draw five hours of them is the cost of that noise.
    const user = userEvent.setup();
    const now = Date.now();
    const stub = stubHistory([quotaSample({ observedAt: now - 600_000, used: 400 })], now);
    renderWithProviders(<AccountsBoard />);

    await user.click(
      await screen.findByRole("button", { name: "Show quota history for claude-main" }),
    );
    await screen.findByText("Window average");

    await waitFor(() => {
      expect(stub.calls.some((call) => call.url.startsWith("/api/credentials/quota/history"))).toBe(
        true,
      );
    });
    const call = stub.calls.find((c) => c.url.startsWith("/api/credentials/quota/history"));
    const since = Number(new URL(call?.url ?? "", "http://x").searchParams.get("since"));

    // The window began an hour ago and runs five hours, so itself plus the one
    // before it reaches back six hours from now — not to the epoch.
    expect(since).toBe(now - 6 * 3_600_000);
  });

  test("a panel charts only its own span, not everything the request returned", async () => {
    // One request covers every window on the row, so its span is the widest
    // one asked for. A weekly window reaches back eleven days, and that
    // response carries five-hour samples from windows that ended days ago —
    // which belong on no chart drawn here.
    const user = userEvent.setup();
    const now = Date.now();
    const fiveHour = quota({
      used: 500,
      limit: 1_000,
      observedAt: now - 30_000,
      resetsAt: now + 4 * 3_600_000,
    });
    const weekly = quota({
      windowType: "weekly",
      used: 100,
      limit: 1_000,
      observedAt: now - 30_000,
      resetsAt: now + 3 * 86_400_000,
    });
    stubAccounts({
      "GET /api/credentials/health": () => ({
        health: [health()],
        quota: [fiveHour, weekly],
        burn: [
          burn({ windowStartsAt: now - 3_600_000, ratePerHour: 500, exhaustsAt: now + 1_800_000 }),
          burn({
            windowType: "weekly",
            windowStartsAt: now - 4 * 86_400_000,
            ratePerHour: 10,
            exhaustsAt: now + 30 * 86_400_000,
            survives: true,
          }),
        ],
      }),
      "GET /api/credentials/quota/history": () => ({
        samples: [
          // A five-hour window that rolled over eight days ago: inside the
          // weekly panel's span, and long outside this one's.
          quotaSample({
            observedAt: now - 8 * 86_400_000,
            used: 900,
            resetsAt: now - 8 * 86_400_000 + 600_000,
          }),
        ],
        gatewayRates,
      }),
    });
    renderWithProviders(<AccountsBoard />);

    await user.click(
      await screen.findByRole("button", { name: "Show quota history for claude-main" }),
    );
    await screen.findAllByText("Window average");

    // Neither panel has a reading inside its own span, so neither draws.
    await waitFor(() => expect(screen.getAllByText("not yet observed")).toHaveLength(2));
  });

  test("a snapshot with no samples yet still carries the estimate", async () => {
    // The estimate is a whole-window average over one reading, so it is
    // available from the first probe; only the chart waits for history.
    const user = userEvent.setup();
    stubHistory([]);
    renderWithProviders(<AccountsBoard />);

    expect(await screen.findByText(/^5h · empty ~\d+m · resets in \d+h$/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show quota history for claude-main" }));

    expect(await screen.findByText("Window average")).toBeTruthy();
    expect(screen.getByText("not yet observed")).toBeTruthy();
  });

  test("a window with no ceiling says so instead of drawing an empty chart", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    stubAccounts({
      "GET /api/credentials/health": () => ({
        health: [health()],
        quota: [
          quota({ used: 500, limit: null, observedAt: now - 30_000, resetsAt: now + 3_600_000 }),
        ],
        burn: [burn({ windowStartsAt: now - 3_600_000, exhaustsAt: null, survives: true })],
      }),
      "GET /api/credentials/quota/history": () => ({ samples: [] }),
    });
    renderWithProviders(<AccountsBoard />);

    await user.click(
      await screen.findByRole("button", { name: "Show quota history for claude-main" }),
    );

    expect(await screen.findByText("no ceiling reported")).toBeTruthy();
    // `survives` is true by construction whenever there is no `exhaustsAt`, and
    // no ceiling is one of the ways to have none. Reading it first prints a
    // positive claim beside the panel saying nothing is known.
    expect(screen.queryByText("lasts the window")).toBeNull();
    expect(screen.getAllByText("unknown").length).toBeGreaterThan(0);
  });

  test("a window with no reported reset makes no claim about lasting", async () => {
    // The other arm of the same defect: with no reset there is no window start,
    // so there is no rate and nothing to outlive.
    const user = userEvent.setup();
    const now = Date.now();
    stubAccounts({
      "GET /api/credentials/health": () => ({
        health: [health()],
        quota: [quota({ used: 500, limit: 1_000, observedAt: now - 30_000, resetsAt: null })],
        burn: [burn({ windowStartsAt: null, ratePerHour: null, exhaustsAt: null, survives: true })],
      }),
      "GET /api/credentials/quota/history": () => ({ samples: [] }),
    });
    renderWithProviders(<AccountsBoard />);

    await user.click(
      await screen.findByRole("button", { name: "Show quota history for claude-main" }),
    );

    expect(await screen.findByText("no reset reported")).toBeTruthy();
    expect(screen.queryByText("lasts the window")).toBeNull();
  });

  test("a stale reading is reported as stale rather than charted", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    stubAccounts({
      "GET /api/credentials/health": () => ({
        health: [health()],
        quota: [
          quota({
            used: 500,
            limit: 1_000,
            observedAt: now - 3_600_000,
            resetsAt: now + 3_600_000,
          }),
        ],
        burn: [burn({ credentialId: "cred-1", stale: true, windowStartsAt: null, survives: null })],
      }),
      "GET /api/credentials/quota/history": () => ({ samples: [] }),
    });
    renderWithProviders(<AccountsBoard />);

    await user.click(
      await screen.findByRole("button", { name: "Show quota history for claude-main" }),
    );

    expect(await screen.findByText("reading is stale")).toBeTruthy();
  });
});

describe("AccountsBoard quota pace", () => {
  const HOUR = 3_600_000;
  const gatewayRates = [
    { credentialId: "cred-1", windowType: "fiveHour", gatewayRatePerHour: 120_000 },
  ];

  type PacePatch = {
    window?: Partial<QuotaWindow>;
    burn?: Partial<BurnEstimate>;
    samples?: QuotaSample[];
  };

  /**
   * A five-hour window at 62%, burning 240 units an hour, read five minutes ago.
   *
   * The reading is deliberately old enough to tell apart from `now`: the
   * projection is anchored to `observedAt`, and a fixture where the two nearly
   * coincide cannot say whether it was.
   */
  function stubPace(now: number, patch: PacePatch = {}) {
    const resetsAt = now + 4 * HOUR;
    const observedAt = now - 5 * 60_000;
    return stubAccounts({
      "GET /api/credentials/health": () => ({
        health: [health()],
        quota: [quota({ used: 620, limit: 1_000, observedAt, resetsAt, ...patch.window })],
        burn: [
          burn({
            windowStartsAt: resetsAt - 5 * HOUR,
            ratePerHour: 240,
            exhaustsAt: observedAt + ((1_000 - 620) / 240) * HOUR,
            survives: false,
            ...patch.burn,
          }),
        ],
      }),
      "GET /api/credentials/quota/history": () => ({
        samples: patch.samples ?? [
          quotaSample({ observedAt: resetsAt - 5 * HOUR + 600_000, used: 200, resetsAt }),
          quotaSample({ observedAt: now - 600_000, used: 500, resetsAt }),
        ],
        gatewayRates,
      }),
    });
  }

  async function openPace(now: number, patch: PacePatch = {}) {
    const user = userEvent.setup();
    stubPace(now, patch);
    const view = renderWithProviders(<AccountsBoard />);
    await user.click(
      await screen.findByRole("button", { name: "Show quota history for claude-main" }),
    );
    await screen.findByText("Window average");
    return view;
  }

  /** What one fact reads, without the legend that names it. */
  function factValue(label: string): string {
    const legend = screen.getByText(label);
    return (legend.parentElement?.textContent ?? "").replace(label, "");
  }

  function corners(paths: string[], index: number): Array<[number, number]> {
    const path = paths[index];
    if (path === undefined) throw new Error(`no line at ${index}`);
    return vertices(path);
  }

  function corner(paths: string[], index: number, at: number): [number, number] {
    const point = corners(paths, index)[at];
    if (point === undefined) throw new Error(`no vertex ${at} of line ${index}`);
    return point;
  }

  test("draws the budget as a straight climb from empty at the start to full at the reset", async () => {
    const restore = measureCharts();
    try {
      const now = Date.now();
      const { container } = await openPace(now);

      await waitFor(() => expect(dashedPaths(container, PACE_DASH.budget)).toHaveLength(1));
      const budget = dashedPaths(container, PACE_DASH.budget);
      expect(corners(budget, 0)).toHaveLength(2);

      const [startX, startY] = corner(budget, 0, 0);
      const [endX, endY] = corner(budget, 0, 1);
      expect(startX).toBeLessThan(endX);
      // Y grows downward, so a budget that reaches the ceiling ends above the
      // floor it started on.
      expect(startY).toBeGreaterThan(endY);
    } finally {
      restore();
    }
  });

  test("gives the window before this one a budget of its own, and no projection", async () => {
    // The preceding window reset on its own schedule and ran its own length.
    // Drawing it against the current window's reset would slope its pace
    // across a span it never occupied.
    const restore = measureCharts();
    try {
      const now = Date.now();
      const resetsAt = now + 4 * HOUR;
      const previous = resetsAt - 5 * HOUR;
      const { container } = await openPace(now, {
        samples: [
          quotaSample({ observedAt: previous - 2 * HOUR, used: 300, resetsAt: previous }),
          quotaSample({ observedAt: previous - 600_000, used: 900, resetsAt: previous }),
          quotaSample({ observedAt: previous + 600_000, used: 200, resetsAt }),
          quotaSample({ observedAt: now - 600_000, used: 500, resetsAt }),
        ],
      });

      await waitFor(() => expect(dashedPaths(container, PACE_DASH.budget)).toHaveLength(2));
      const budgets = dashedPaths(container, PACE_DASH.budget);
      const [beforeEndX, beforeEndY] = corner(budgets, 0, 1);
      const [currentStartX, currentStartY] = corner(budgets, 1, 0);
      const [currentEndX] = corner(budgets, 1, 1);

      // The two windows abut: the earlier budget reaches full exactly where the
      // current one starts empty, and finishes well short of this reset.
      expect(Math.abs(beforeEndX - currentStartX)).toBeLessThan(0.5);
      expect(beforeEndX).toBeLessThan(currentEndX - 1);
      expect(beforeEndY).toBeLessThan(currentStartY);

      // Only the live window is carried forward; the one before it is over.
      expect(dashedPaths(container, PACE_DASH.projection)).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test("the projection crosses the ceiling exactly where the estimate empties the window", async () => {
    // The projection and `exhaustsAt` are one claim drawn two ways: both start
    // at `observedAt` and both run at `ratePerHour`. Reading the crossing back
    // off the rendered chart is the only check that catches a projection
    // anchored to `now`, which every other assertion here would still pass.
    const restore = measureCharts();
    try {
      const now = Date.now();
      const resetsAt = now + 4 * HOUR;
      const windowStart = resetsAt - 5 * HOUR;
      const exhaustsAt = now - 5 * 60_000 + ((1_000 - 620) / 240) * HOUR;
      const { container } = await openPace(now);

      await waitFor(() => expect(dashedPaths(container, PACE_DASH.projection)).toHaveLength(1));
      // The budget's ends are two known instants at two known percentages,
      // which is scale enough to read every other pixel on the chart.
      const budget = dashedPaths(container, PACE_DASH.budget);
      const [emptyX] = corner(budget, 0, 0);
      const [fullX, fullY] = corner(budget, 0, 1);
      const projection = dashedPaths(container, PACE_DASH.projection);
      const [headX, headY] = corner(projection, 0, 0);
      const [tailX, tailY] = corner(projection, 0, 1);

      const ceilingX = headX + ((fullY - headY) / (tailY - headY)) * (tailX - headX);
      const crossesAt =
        windowStart + ((ceilingX - emptyX) / (fullX - emptyX)) * (resetsAt - windowStart);

      expect(Math.abs(crossesAt - exhaustsAt)).toBeLessThan(30_000);
    } finally {
      restore();
    }
  });

  test("names what the reading projects to by the reset", async () => {
    const now = Date.now();
    await openPace(now);

    // 62% already spent, 24 points an hour, four hours and five minutes to go.
    expect(screen.getByText("Projected")).toBeTruthy();
    expect(factValue("Projected")).toBe("160% of limit by reset");
  });

  test("lifts the ceiling of the chart so an overshoot is visible rather than clipped", async () => {
    const restore = measureCharts();
    try {
      const now = Date.now();
      const { container } = await openPace(now);

      await waitFor(() => expect(axisTicks(container, "yAxis").length).toBeGreaterThan(0));
      const top = Math.max(...axisTicks(container, "yAxis").map((tick) => Number.parseFloat(tick)));
      expect(top).toBeGreaterThanOrEqual(160);
    } finally {
      restore();
    }
  });

  test("keeps the axis at one full window when the projection stays under it", async () => {
    const restore = measureCharts();
    try {
      const now = Date.now();
      const { container } = await openPace(now, {
        window: { used: 200 },
        burn: { ratePerHour: 100, exhaustsAt: null, survives: true },
      });

      await waitFor(() => expect(axisTicks(container, "yAxis").length).toBeGreaterThan(0));
      const top = Math.max(...axisTicks(container, "yAxis").map((tick) => Number.parseFloat(tick)));
      expect(top).toBe(100);
      expect(factValue("Projected")).toBe("61% of limit by reset");
    } finally {
      restore();
    }
  });

  test("a window with no inferable rate keeps its budget and projects nothing", async () => {
    const restore = measureCharts();
    try {
      const now = Date.now();
      const { container } = await openPace(now, {
        burn: { ratePerHour: null, exhaustsAt: null, survives: null },
      });

      await waitFor(() => expect(dashedPaths(container, PACE_DASH.budget)).toHaveLength(1));
      expect(dashedPaths(container, PACE_DASH.projection)).toHaveLength(0);
      expect(factValue("Projected")).toBe("unknown");
    } finally {
      restore();
    }
  });

  test("a rate of zero is not projected as a flat line", async () => {
    // One reading into a window reports zero, which is "nothing measured yet",
    // not "this account will never spend another token".
    const restore = measureCharts();
    try {
      const now = Date.now();
      const { container } = await openPace(now, {
        burn: { ratePerHour: 0, exhaustsAt: null, survives: true },
      });

      await waitFor(() => expect(dashedPaths(container, PACE_DASH.budget)).toHaveLength(1));
      expect(dashedPaths(container, PACE_DASH.projection)).toHaveLength(0);
      expect(factValue("Projected")).toBe("unknown");
    } finally {
      restore();
    }
  });

  test("a window with no ceiling draws neither pace and projects nothing", async () => {
    const restore = measureCharts();
    try {
      const now = Date.now();
      const { container } = await openPace(now, {
        window: { limit: null },
        burn: { exhaustsAt: null, survives: true },
      });

      expect(await screen.findByText("no ceiling reported")).toBeTruthy();
      expect(dashedPaths(container, PACE_DASH.budget)).toHaveLength(0);
      expect(dashedPaths(container, PACE_DASH.projection)).toHaveLength(0);
      expect(factValue("Projected")).toBe("unknown");
    } finally {
      restore();
    }
  });

  test("a window with no reported reset draws neither pace and projects nothing", async () => {
    const restore = measureCharts();
    try {
      const now = Date.now();
      const { container } = await openPace(now, {
        window: { resetsAt: null },
        burn: { windowStartsAt: null, ratePerHour: null, exhaustsAt: null, survives: null },
      });

      expect(await screen.findByText("no reset reported")).toBeTruthy();
      expect(dashedPaths(container, PACE_DASH.budget)).toHaveLength(0);
      expect(dashedPaths(container, PACE_DASH.projection)).toHaveLength(0);
      expect(factValue("Projected")).toBe("unknown");
    } finally {
      restore();
    }
  });
});
