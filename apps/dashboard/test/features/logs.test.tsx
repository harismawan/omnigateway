import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LogsBoard } from "../../src/features/logs/LogsBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { credential, log, NOW } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const logs = [
  log({ id: "req-ok", requestedModel: "fast", at: NOW - 10_000 }),
  log({
    id: "req-bad",
    requestedModel: "deep",
    at: NOW - 20_000,
    status: 502,
    errorCode: "ALL_CANDIDATES_FAILED",
    resolvedProvider: null,
    resolvedModel: null,
    credentialId: null,
    attempts: 3,
    ttftMs: null,
    costUsd: 0,
    degradations: ["droppedThinking"],
  }),
];

function stubLogs(overrides: Parameters<typeof createFetchStub>[0] = {}) {
  return createFetchStub({
    "GET /api/logs": () => ({ logs }),
    "GET /api/credentials": () => ({ credentials: [credential()] }),
    ...overrides,
  });
}

describe("LogsBoard", () => {
  test("counts failures and states that bodies are not recorded", async () => {
    stubLogs();
    renderWithProviders(<LogsBoard />);

    expect(
      await screen.findByText(
        "2 recent requests, 1 of them failed. Prompt and response bodies are never recorded.",
      ),
    ).toBeTruthy();
  });

  test("resolves a credential id to the account's label", async () => {
    stubLogs();
    renderWithProviders(<LogsBoard />);
    expect(await screen.findByText("claude-main")).toBeTruthy();
  });

  test("an unrouted request says so instead of showing a blank cell", async () => {
    stubLogs();
    renderWithProviders(<LogsBoard />);

    expect(await screen.findByText("not routed")).toBeTruthy();
    expect(screen.getByText("ALL_CANDIDATES_FAILED")).toBeTruthy();
  });

  test("the failed filter hides successful requests", async () => {
    const user = userEvent.setup();
    stubLogs();
    renderWithProviders(<LogsBoard />);

    await screen.findByText("fast");
    await user.selectOptions(screen.getByLabelText("Show which requests"), "failed");

    await waitFor(() => expect(screen.queryByText("fast")).toBeNull());
    expect(screen.getByText("deep")).toBeTruthy();
    expect(screen.getByText("1 shown")).toBeTruthy();
  });

  test("the search box matches model, account, and error code", async () => {
    const user = userEvent.setup();
    stubLogs();
    renderWithProviders(<LogsBoard />);

    const search = await screen.findByLabelText("Filter requests");
    await user.type(search, "ALL_CANDIDATES");

    await waitFor(() => expect(screen.queryByText("fast")).toBeNull());
    expect(screen.getByText("deep")).toBeTruthy();
  });

  test("a filter that matches nothing says how to recover", async () => {
    const user = userEvent.setup();
    stubLogs();
    renderWithProviders(<LogsBoard />);

    await user.type(await screen.findByLabelText("Filter requests"), "nothing-matches-this");
    expect(
      await screen.findByText(
        "No request in this window matches the filter. Clear it to see everything.",
      ),
    ).toBeTruthy();
  });

  test("changing the depth refetches with the new limit", async () => {
    const user = userEvent.setup();
    const stub = stubLogs();
    renderWithProviders(<LogsBoard />);

    await screen.findByText("fast");
    await user.selectOptions(screen.getByLabelText("How many requests to fetch"), "500");

    await waitFor(() => {
      expect(stub.calls.some((call) => call.url === "/api/logs?limit=500")).toBe(true);
    });
  });

  test("opening a row shows the routing detail and any degradations", async () => {
    const user = userEvent.setup();
    stubLogs();
    renderWithProviders(<LogsBoard />);

    await user.click(await screen.findByText("deep"));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText("req-bad")).toBeTruthy();
    expect(within(dialog).getByText("502 ALL_CANDIDATES_FAILED")).toBeTruthy();
    expect(within(dialog).getByText("droppedThinking")).toBeTruthy();
  });

  test("a request still in flight shows a live lamp and no measurements", async () => {
    createFetchStub({
      "GET /api/logs": () => ({
        logs: [
          log({
            id: "req-live",
            state: "pending",
            requestedModel: "fast",
            status: 0,
            attempts: 0,
            resolvedProvider: "anthropic",
            resolvedModel: "claude-opus-4",
            credentialId: "cred-1",
            inputTokens: 0,
            outputTokens: 0,
            ttftMs: null,
            durationMs: 0,
            costUsd: 0,
          }),
        ],
      }),
      "GET /api/credentials": () => ({ credentials: [credential()] }),
    });
    renderWithProviders(<LogsBoard />);

    expect(await screen.findByLabelText("in flight")).toBeTruthy();
    expect(screen.getByText("anthropic")).toBeTruthy();
    expect(screen.getByText("claude-opus-4")).toBeTruthy();
    expect(screen.getByText("claude-main")).toBeTruthy();
    const live = screen.getByText("live");
    const generatedClass = live.className.split(" ").at(-1);
    if (generatedClass === undefined) throw new Error("live chip has no generated class");
    const injected = [...document.querySelectorAll("style")]
      .map((node) => node.textContent ?? "")
      .join("");
    const rule = injected.match(new RegExp(`\\.${generatedClass}\\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule).toContain("color:var(--accent)");
    expect(rule).toContain("background:var(--accent-wash)");
    // Every measured column is an em dash rather than a nought nobody counted:
    // attempts, TTFT, total, tokens, and cost.
    expect(screen.getAllByText("—")).toHaveLength(5);
  });

  test("a request still in flight is counted as running, not as failed", async () => {
    createFetchStub({
      "GET /api/logs": () => ({
        logs: [...logs, log({ id: "req-live", state: "pending", status: 0 })],
      }),
      "GET /api/credentials": () => ({ credentials: [credential()] }),
    });
    renderWithProviders(<LogsBoard />);

    expect(
      await screen.findByText(
        "3 recent requests, 1 of them failed, 1 still running. Prompt and response bodies are never recorded.",
      ),
    ).toBeTruthy();
  });

  test("the failed filter hides a request that has not finished", async () => {
    const user = userEvent.setup();
    createFetchStub({
      "GET /api/logs": () => ({
        logs: [...logs, log({ id: "req-live", state: "pending", requestedModel: "live-one" })],
      }),
      "GET /api/credentials": () => ({ credentials: [credential()] }),
    });
    renderWithProviders(<LogsBoard />);

    await screen.findByText("live-one");
    await user.selectOptions(screen.getByLabelText("Show which requests"), "failed");

    await waitFor(() => expect(screen.queryByText("live-one")).toBeNull());
    expect(screen.getByText("1 shown")).toBeTruthy();
  });

  test("a quiet gateway invites traffic rather than showing an empty table", async () => {
    createFetchStub({
      "GET /api/logs": () => ({ logs: [] }),
      "GET /api/credentials": () => ({ credentials: [] }),
    });
    renderWithProviders(<LogsBoard />);

    expect(await screen.findByText("No requests have reached the gateway yet.")).toBeTruthy();
  });
});
