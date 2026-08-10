import { describe, expect, setSystemTime, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LogsBoard } from "../../src/features/logs/LogsBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { apiKey, credential, log, NOW } from "../helpers/fixtures.ts";
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
    "GET /api/keys": () => ({ keys: [apiKey()] }),
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

  test("breaks a completed request's tokens into four compact categories", async () => {
    createFetchStub({
      "GET /api/logs": () => ({
        logs: [
          log({
            inputTokens: 1_234,
            outputTokens: 0,
            cacheReadTokens: 89_010,
            cacheWriteTokens: 234,
          }),
        ],
      }),
      "GET /api/credentials": () => ({ credentials: [credential()] }),
    });
    renderWithProviders(<LogsBoard />);

    const tokens = await screen.findByRole("cell", {
      name: "1,234 input, 0 output, 89,010 cache read, 234 cache write tokens",
    });
    expect(tokens.textContent).toBe("1,234089k234");
    expect(tokens.getAttribute("title")).toBe(
      "1,234 input, 0 output, 89,010 cache read, 234 cache write tokens",
    );
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

  test("resolves an api key id to the key's label", async () => {
    stubLogs();
    renderWithProviders(<LogsBoard />);

    // Both rows were made by the same key, so the label appears once per row.
    await waitFor(() => expect(screen.getAllByText("laptop")).toHaveLength(2));
  });

  test("falls back to the id for a key that has since been deleted", async () => {
    createFetchStub({
      "GET /api/logs": () => ({ logs: [log({ id: "req-1", apiKeyId: "key-gone" })] }),
      "GET /api/credentials": () => ({ credentials: [credential()] }),
      "GET /api/keys": () => ({ keys: [] }),
    });
    renderWithProviders(<LogsBoard />);

    // A revoked key keeps its requests in the log; the row still has to say
    // which key, and the full id is the title.
    const cell = await screen.findByTitle("key-gone");
    expect(cell.textContent).toBe("key-gone");
  });

  test("shows an em dash for a request that carried no key", async () => {
    createFetchStub({
      "GET /api/logs": () => ({ logs: [log({ id: "req-1", apiKeyId: null })] }),
      "GET /api/credentials": () => ({ credentials: [credential()] }),
      "GET /api/keys": () => ({ keys: [apiKey()] }),
    });
    renderWithProviders(<LogsBoard />);

    await screen.findByText("claude-main");
    expect(screen.queryByText("laptop")).toBeNull();
  });

  test("the search box matches a key label", async () => {
    const user = userEvent.setup();
    createFetchStub({
      "GET /api/logs": () => ({
        logs: [
          log({ id: "req-laptop", requestedModel: "fast", apiKeyId: "key-1" }),
          log({ id: "req-ci", requestedModel: "deep", apiKeyId: "key-2" }),
        ],
      }),
      "GET /api/credentials": () => ({ credentials: [credential()] }),
      "GET /api/keys": () => ({
        keys: [apiKey(), apiKey({ id: "key-2", label: "ci-runner" })],
      }),
    });
    renderWithProviders(<LogsBoard />);

    await user.type(await screen.findByLabelText("Filter requests"), "ci-runner");

    await waitFor(() => expect(screen.queryByText("fast")).toBeNull());
    expect(screen.getByText("deep")).toBeTruthy();
  });

  test("request detail shows RTK aggregate metrics without content", async () => {
    const user = userEvent.setup();
    createFetchStub({
      "GET /api/logs": () => ({
        logs: [
          log({
            rtkApplied: true,
            rtkFilterHits: 2,
            rtkOriginalCodeUnits: 2_000,
            rtkCompressedCodeUnits: 700,
            rtkEstimatedTokensSaved: 325,
            rtkFilters: ["test-output", "deduplicate-log"],
          }),
        ],
      }),
      "GET /api/credentials": () => ({ credentials: [credential()] }),
      "GET /api/keys": () => ({ keys: [apiKey()] }),
    });
    renderWithProviders(<LogsBoard />);

    await user.click(await screen.findByText("fast"));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("2 hits · 2,000 → 700 code units · ~325 tokens saved"),
    ).toBeTruthy();
    expect(within(dialog).getByText("test-output, deduplicate-log")).toBeTruthy();
  });

  test("the detail shows the key's label rather than its id", async () => {
    const user = userEvent.setup();
    stubLogs();
    renderWithProviders(<LogsBoard />);

    await user.click(await screen.findByText("deep"));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText("laptop")).toBeTruthy();
    expect(within(dialog).queryByText("key-1")).toBeNull();
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
    // Provider-reported measurements stay unavailable until completion:
    // attempts, TTFT, tokens, and cost. Total is live elapsed wall-clock time.
    expect(screen.getAllByText("—")).toHaveLength(4);
  });

  test("a request still in flight updates its elapsed total", async () => {
    setSystemTime(NOW);
    const request = log({ id: "req-live", state: "pending", status: 0, at: NOW - 1_000 });
    createFetchStub({
      "GET /api/logs": () => ({ logs: [request] }),
      "GET /api/credentials": () => ({ credentials: [credential()] }),
      "GET /api/keys": () => ({ keys: [apiKey()] }),
    });
    const view = renderWithProviders(<LogsBoard />);

    try {
      const row = (await screen.findByLabelText("in flight")).closest("tr");
      if (row === null) throw new Error("live request has no table row");
      expect(within(row).getByText("1.0s")).toBeTruthy();

      setSystemTime(NOW + 1_000);
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 1_050));
      });
      expect(within(row).getByText("2.0s")).toBeTruthy();

      request.state = "done";
      request.durationMs = 1_500;
      await act(async () => {
        await view.client.refetchQueries({ queryKey: ["logs", 100] });
      });
      await waitFor(() => expect(screen.queryByLabelText("in flight")).toBeNull());
      expect(screen.getByText("1.5s")).toBeTruthy();
    } finally {
      setSystemTime();
    }
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
