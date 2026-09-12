import { describe, expect, setSystemTime, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TERM_DEBOUNCE_MS } from "../../src/features/logs/LogFilterBar.tsx";
import { LogsBoard } from "../../src/features/logs/LogsBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import {
  apiKey,
  bodyArtifact,
  credential,
  log,
  NOW,
  requestBody,
  settings,
} from "../helpers/fixtures.ts";
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
    "GET /api/logs": () => ({ logs, nextCursor: null }),
    "GET /api/credentials": () => ({ credentials: [credential()] }),
    "GET /api/keys": () => ({ keys: [apiKey()] }),
    // The board states what this gateway does with prompts, and that answer is
    // a function of both capture keys, so the settings envelope is part of the
    // default fixture rather than something each test remembers to add.
    "GET /api/settings": () => ({ settings, bodyLoggingAllowed: false }),
    "GET /api/requests/req-1/body": () => requestBody({ detailState: "none", artifact: null }),
    ...overrides,
  });
}

describe("LogsBoard", () => {
  test("counts failures and states that bodies are not recorded", async () => {
    stubLogs();
    renderWithProviders(<LogsBoard />);

    expect(
      await screen.findByText(
        "2 requests loaded, 1 of them failed. Prompt and response bodies are not being recorded.",
      ),
    ).toBeTruthy();
  });

  /**
   * The claim has to move with the configuration.
   *
   * Both keys are needed to record anything, so a board that answered on the
   * setting alone would tell an operator on an installation that never permitted
   * capture that their prompts are being kept.
   */
  test("the summary answers on both capture keys, not on the setting alone", async () => {
    stubLogs({
      "GET /api/settings": () => ({
        settings: { ...settings, bodyLoggingEnabled: true },
        bodyLoggingAllowed: false,
      }),
    });
    renderWithProviders(<LogsBoard />);

    expect(
      await screen.findByText(
        "2 requests loaded, 1 of them failed. Prompt and response bodies are not being recorded.",
      ),
    ).toBeTruthy();
  });

  test("the summary says capture is on when both keys are set", async () => {
    stubLogs({
      "GET /api/settings": () => ({
        settings: { ...settings, bodyLoggingEnabled: true },
        bodyLoggingAllowed: true,
      }),
    });
    renderWithProviders(<LogsBoard />);

    expect(
      await screen.findByText(
        "2 requests loaded, 1 of them failed. Body capture is on: open a request to read what it sent and received.",
      ),
    ).toBeTruthy();
  });

  test("scrolls request rows inside the bounded log module", async () => {
    stubLogs();
    renderWithProviders(<LogsBoard />);

    const scroller = await screen.findByTestId("request-log-scroller");
    expect(getComputedStyle(scroller).overflowY).toBe("auto");
  });

  test("resolves a credential id to the account's label", async () => {
    stubLogs();
    renderWithProviders(<LogsBoard />);
    // Scoped to the table: the filter bar offers the same labels as options, so
    // an unscoped query would pass on the control alone and prove nothing about
    // the row.
    const table = await screen.findByRole("table");
    expect(within(table).getByText("claude-main")).toBeTruthy();
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

  /**
   * Every filter is a request parameter, which is the whole point of the
   * change: the gateway matches before it applies the limit, so the answer is
   * "failed requests in the log" rather than "failed requests among the newest
   * hundred rows the board happened to fetch".
   *
   * Asserted on the URL rather than on which rows are rendered — a board that
   * fetched everything and hid rows locally would still show one row here, and
   * would still be answering the wrong question.
   */
  test("the failed filter is sent to the gateway, not applied to the fetched rows", async () => {
    const user = userEvent.setup();
    const stub = stubLogs();
    renderWithProviders(<LogsBoard />);

    await screen.findByText("fast");
    await user.selectOptions(screen.getByLabelText("Show which requests"), "failed");

    await waitFor(() => {
      expect(stub.calls.some((call) => call.url.includes("failed=true"))).toBe(true);
    });
  });

  test("the state filter never asks for a pending row that failed", async () => {
    const user = userEvent.setup();
    const stub = stubLogs();
    renderWithProviders(<LogsBoard />);

    await screen.findByText("fast");
    const control = screen.getByLabelText("Show which requests");
    await user.selectOptions(control, "failed");
    await waitFor(() => {
      expect(stub.calls.some((call) => call.url.includes("failed=true"))).toBe(true);
    });

    // The four positions are exclusive. Switching away from "failed" has to
    // clear it, or the gateway is asked for rows that are both still running
    // and already failed — a set that is always empty.
    await user.selectOptions(control, "pending");
    await waitFor(() => {
      expect(stub.calls.some((call) => call.url.includes("state=pending"))).toBe(true);
    });
    const last = stub.calls.at(-1);
    if (last === undefined) throw new Error("no request was made");
    expect(last.url).not.toContain("failed=");
  });

  test("an exact model filter is sent as a parameter rather than matched locally", async () => {
    const user = userEvent.setup();
    const stub = stubLogs();
    renderWithProviders(<LogsBoard />);

    await screen.findByText("fast");
    const box = screen.getByLabelText("Models and error codes");
    await user.type(box, "claude-opus-4");

    await waitFor(() => {
      expect(stub.calls.some((call) => call.url.includes("resolvedModel=claude-opus-4"))).toBe(
        true,
      );
    });

    // One read for the name, not one per character. Every term is an exact
    // match, so each prefix of a model name is a filter that matches nothing —
    // and matches nothing the expensive way, since a miss has no index to seek
    // and scans the table. Thirteen of those also blank the board thirteen
    // times, which is what a filter that does not work looks like.
    expect(stub.calls.filter((call) => call.url.includes("resolvedModel="))).toHaveLength(1);

    // Emptying the box has to remove the parameter, not leave the last value
    // that parsed: the box writes every term key on every keystroke, so a filter
    // that survived its own text would be one no control could reach.
    await user.clear(box);
    await waitFor(() => {
      const last = stub.calls.at(-1);
      if (last === undefined) throw new Error("no request was made");
      expect(last.url).toBe("/api/logs?limit=100");
    });
  });

  test("an operator can narrow to one gateway key by its label", async () => {
    const user = userEvent.setup();
    const stub = stubLogs();
    renderWithProviders(<LogsBoard />);

    // The control is labelled, but the value sent is the stored id: a row
    // outlives the key that made it, so a renamed key must not change which
    // rows an existing filter selects.
    await user.selectOptions(await screen.findByLabelText("Gateway key"), "laptop");
    await waitFor(() => {
      expect(stub.calls.some((call) => call.url.includes("apiKeyId=key-1"))).toBe(true);
    });
  });

  test("clearing the filters returns to the unfiltered head", async () => {
    const user = userEvent.setup();
    const stub = stubLogs();
    renderWithProviders(<LogsBoard />);

    await screen.findByText("fast");
    await user.selectOptions(screen.getByLabelText("Show which requests"), "failed");
    const box = screen.getByLabelText("Models and error codes");
    await user.type(box, "requested:fast");
    await waitFor(() => {
      expect(stub.calls.some((call) => call.url.includes("failed=true"))).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => {
      const last = stub.calls.at(-1);
      if (last === undefined) throw new Error("no request was made");
      expect(last.url).toBe("/api/logs?limit=100");
    });
    // The box holds its own text, so clearing the filters has to reach it too —
    // a term left on screen after "Clear filters" reads as a filter still set.
    expect((box as HTMLInputElement).value).toBe("");

    // Clearing has to cancel the keystroke still waiting out its debounce.
    // Otherwise the term lands after the button that removed it, and the board
    // filters itself again with nothing on screen saying why.
    await new Promise((resolve) => setTimeout(resolve, TERM_DEBOUNCE_MS * 3));
    expect(stub.calls.some((call) => call.url.includes("requestedModel="))).toBe(false);
  });

  /**
   * A page boundary is a cursor, never an offset.
   *
   * "Load older" has to carry the cursor the previous page returned, and the
   * rows it brings back have to be appended rather than replacing what is on
   * screen — an operator walking back through an afternoon is reading one list,
   * not a sequence of windows.
   */
  test("load older pages on the cursor and appends the rows", async () => {
    const user = userEvent.setup();
    const stub = stubLogs({
      "GET /api/logs": ({ url }) =>
        url.includes("cursor=")
          ? { logs: [logs[1]], nextCursor: null }
          : { logs: [logs[0]], nextCursor: "cursor-2" },
    });
    renderWithProviders(<LogsBoard />);

    await screen.findByText("fast");
    expect(screen.queryByText("deep")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Load older" }));

    expect(await screen.findByText("deep")).toBeTruthy();
    // Still there: the second page was appended, not swapped in.
    expect(screen.getByText("fast")).toBeTruthy();
    expect(stub.calls.some((call) => call.url.includes("cursor=cursor-2"))).toBe(true);
    // And a page that reported no successor offers nothing more to load.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load older" })).toBeNull());
  });

  /**
   * The pause is stated, and it is reversible.
   *
   * Loading scrollback switches off both the poll and `res:logs`, deliberately —
   * refreshing an infinite query re-reads every loaded page. But a head that
   * silently stopped updating reads exactly like a gateway serving nothing, so
   * the board says which of the two it is and offers the way back.
   */
  test("loading older pages says live updates are paused, and offers the way back", async () => {
    const user = userEvent.setup();
    stubLogs({
      "GET /api/logs": ({ url }) =>
        url.includes("cursor=")
          ? { logs: [logs[1]], nextCursor: null }
          : { logs: [logs[0]], nextCursor: "cursor-2" },
    });
    renderWithProviders(<LogsBoard />);

    await screen.findByText("fast");
    expect(screen.queryByText(/Live updates are paused/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Load older" }));
    await screen.findByText("deep");
    expect(screen.getByText(/Live updates are paused/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Back to live" }));

    // Back to one page: the scrollback is dropped, so the head is live again.
    await waitFor(() => expect(screen.queryByText("deep")).toBeNull());
    expect(screen.getByText("fast")).toBeTruthy();
    expect(screen.queryByText(/Live updates are paused/)).toBeNull();
  });

  /**
   * The way back wins against a page still arriving.
   *
   * `setQueryData` alone does not: an in-flight `fetchNextPage` resolves against
   * the page list it captured when it started, so it writes the trimmed pages
   * back alongside the one it fetched and the board sits paused with the button
   * already clicked. The fetch is cancelled first, which is what makes the
   * reversal unconditional rather than only true while idle.
   */
  test("back to live wins over a page that is still arriving", async () => {
    const user = userEvent.setup();
    // A holder rather than a bare `let`: assigned inside a callback, a `let`
    // narrows to `never` and the call below stops compiling.
    const held: { release: (() => void) | null } = { release: null };
    stubLogs({
      "GET /api/logs": async ({ url }) => {
        if (url.includes("cursor=page-3")) {
          // Held open, so the trim lands while this page is on the wire. A board
          // is only paused once it has two pages, so the race needs a third.
          await new Promise<void>((resolve) => {
            held.release = resolve;
          });
          return { logs: [], nextCursor: null };
        }
        if (url.includes("cursor=page-2")) return { logs: [logs[1]], nextCursor: "page-3" };
        return { logs: [logs[0]], nextCursor: "page-2" };
      },
    });
    renderWithProviders(<LogsBoard />);

    await screen.findByText("fast");
    await user.click(screen.getByRole("button", { name: "Load older" }));
    await screen.findByText("deep");
    await user.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(held.release).not.toBeNull());

    await user.click(screen.getByRole("button", { name: "Back to live" }));
    held.release?.();

    // The page that landed after the trim does not put the scrollback back.
    await waitFor(() => expect(screen.queryByText("deep")).toBeNull());
    expect(screen.queryByText(/Live updates are paused/)).toBeNull();
    expect(screen.getByText("fast")).toBeTruthy();
  });

  test("changing a filter starts again at the head rather than reusing a cursor", async () => {
    const user = userEvent.setup();
    const stub = stubLogs({
      "GET /api/logs": ({ url }) =>
        url.includes("cursor=")
          ? { logs: [logs[1]], nextCursor: null }
          : { logs: [logs[0]], nextCursor: "cursor-2" },
    });
    renderWithProviders(<LogsBoard />);

    await screen.findByText("fast");
    await user.click(screen.getByRole("button", { name: "Load older" }));
    await screen.findByText("deep");

    await user.selectOptions(screen.getByLabelText("Show which requests"), "failed");

    await waitFor(() => {
      const last = stub.calls.at(-1);
      if (last === undefined) throw new Error("no request was made");
      expect(last.url).toContain("failed=true");
      // A cursor cut from the previous filter's ordering would silently skip
      // rows: it names a position in a different sequence.
      expect(last.url).not.toContain("cursor=");
    });
  });

  test("resolves an api key id to the key's label", async () => {
    stubLogs();
    renderWithProviders(<LogsBoard />);

    // Both rows were made by the same key, so the label appears once per row.
    // Scoped to the table, past the filter bar's option of the same name.
    const table = await screen.findByRole("table");
    await waitFor(() => expect(within(table).getAllByText("laptop")).toHaveLength(2));
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

    const table = await screen.findByRole("table");
    expect(within(table).getByText("claude-main")).toBeTruthy();
    expect(within(table).queryByText("laptop")).toBeNull();
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

  test("request detail renders every RTK family ID without prompt content", async () => {
    const user = userEvent.setup();
    const families = [
      "git-diff",
      "git-status",
      "git-log",
      "grep",
      "path-list",
      "numbered-read",
      "build-output",
      "test-output",
      "deduplicate-log",
      "smart-truncate",
      "lint-output",
      "package-output",
      "tree-output",
      "git-operation",
      "docker-build",
    ] as const;
    createFetchStub({
      "GET /api/logs": () => ({ logs: [log({ rtkApplied: true, rtkFilters: [...families] })] }),
      "GET /api/credentials": () => ({ credentials: [credential()] }),
      "GET /api/keys": () => ({ keys: [apiKey()] }),
    });
    renderWithProviders(<LogsBoard />);
    await user.click(await screen.findByText("fast"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(families.join(", "))).toBeTruthy();
    expect(within(dialog).queryByText(/prompt|command|toolUseId/i)).toBeNull();
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

  /**
   * Two empty results that mean different things.
   *
   * A filtered read coming back empty is a filter that missed; an unfiltered one
   * is a gateway that has served nothing. Reporting the second as the first
   * sends an operator hunting for a filter they never set.
   */
  test("a filter that matches nothing says how to recover", async () => {
    const user = userEvent.setup();
    stubLogs({ "GET /api/logs": () => ({ logs: [], nextCursor: null }) });
    renderWithProviders(<LogsBoard />);

    await screen.findByText("No requests have reached the gateway yet.");
    await user.type(screen.getByLabelText("Models and error codes"), "error:OVERLOADED");
    expect(
      await screen.findByText("No request matches these filters. Clear them to see everything."),
    ).toBeTruthy();
  });

  test("changing the page size refetches with the new limit", async () => {
    const user = userEvent.setup();
    const stub = stubLogs();
    renderWithProviders(<LogsBoard />);

    await screen.findByText("fast");
    await user.selectOptions(screen.getByLabelText("How many requests per page"), "500");

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
    const table = screen.getByRole("table");
    expect(within(table).getByText("anthropic")).toBeTruthy();
    expect(within(table).getByText("claude-opus-4")).toBeTruthy();
    expect(within(table).getByText("claude-main")).toBeTruthy();
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
    // attempts, TTFT, and cost. Total is live elapsed wall-clock time, while
    // tokens name the work still underway.
    const processing = screen.getByRole("cell", { name: "processing" });
    expect(processing.textContent).toBe("processing...");
    const dots = processing.querySelector("span span");
    if (dots === null) throw new Error("processing text has no dot slot");
    expect(getComputedStyle(dots).width).toBe("3ch");
    expect(screen.getAllByText("—")).toHaveLength(3);
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
      expect(within(row).getByText("1s")).toBeTruthy();

      setSystemTime(NOW + 1_000);
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 1_050));
      });
      expect(within(row).getByText("2s")).toBeTruthy();

      request.state = "done";
      request.durationMs = 1_500;
      await act(async () => {
        await view.client.refetchQueries({ queryKey: ["logPages"] });
      });
      await waitFor(() => expect(screen.queryByLabelText("in flight")).toBeNull());
      expect(screen.getByText("1.5s")).toBeTruthy();
    } finally {
      setSystemTime();
    }
    // `setSystemTime` moves the clock, not the timers, so the wait for
    // LogsBoard's own 1s tick (`LogsBoard.tsx:69`) is real wall time. The
    // default 5s budget leaves under four seconds for a render, three queries
    // and a refetch, which holds on a developer's machine and does not hold on
    // a loaded CI runner. The number says what the test actually needs rather
    // than how long it usually takes.
  }, 20_000);

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
        "3 requests loaded, 1 of them failed, 1 still running. Prompt and response bodies are not being recorded.",
      ),
    ).toBeTruthy();
  });

  /**
   * The pre/post-RTK split, which is the whole reason both halves are stored.
   *
   * `client.request` is what arrived and every `attempts[].request` is what went
   * upstream after RTK filters ran. A reader who cannot tell them apart will
   * read a compressed tool result as what their client actually sent, so the two
   * payloads must be labelled and the caveat must be on screen beside them.
   */
  test("the captured client and provider requests are labelled either side of RTK", async () => {
    const user = userEvent.setup();
    stubLogs({ "GET /api/requests/req-ok/body": () => requestBody({ requestId: "req-ok" }) });
    renderWithProviders(<LogsBoard />);

    await user.click(await screen.findByText("fast"));
    const dialog = await screen.findByRole("dialog");

    const client = await within(dialog).findByRole("heading", {
      name: "Request from the client",
    });
    const upstream = within(dialog).getByRole("heading", {
      name: "Request sent to the provider",
    });

    // Each payload is labelled with the side of RTK it sits on, in its own
    // caption rather than somewhere else in the panel.
    const clientCaption = client.closest("figcaption");
    const upstreamCaption = upstream.closest("figcaption");
    if (clientCaption === null || upstreamCaption === null) {
      throw new Error("a captured payload has no caption");
    }
    expect(clientCaption.textContent).toContain("pre-RTK");
    expect(upstreamCaption.textContent).toContain("post-RTK");
    expect(clientCaption.textContent).not.toContain("post-RTK");
    expect(upstreamCaption.textContent).not.toContain("pre-RTK");

    // And the two really are different payloads in the fixture, so a UI that
    // rendered one of them twice would fail here rather than pass.
    expect(within(dialog).getByText(/FULL-TOOL-RESULT/)).toBeTruthy();
    expect(within(dialog).getByText(/SQUEEZED/)).toBeTruthy();
    expect(
      within(dialog).getByText(/after RTK filters ran, so the two are not the same payload/),
    ).toBeTruthy();
  });

  test("an artifact with no attempts states no RTK caveat it cannot support", async () => {
    const user = userEvent.setup();
    stubLogs({
      "GET /api/requests/req-ok/body": () =>
        requestBody({ requestId: "req-ok", artifact: bodyArtifact({ attempts: [] }) }),
    });
    renderWithProviders(<LogsBoard />);

    await user.click(await screen.findByText("fast"));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("heading", { name: "Request from the client" });
    expect(within(dialog).queryByText(/RTK filters ran/)).toBeNull();
  });

  /**
   * Three absences that mean three different things, and an operator acts on
   * each differently. Rendering any of them as a blank panel or as a crash sends
   * someone hunting for a setting they already have on.
   */
  test("a request that was never captured says so rather than rendering blank", async () => {
    const user = userEvent.setup();
    stubLogs({
      "GET /api/requests/req-ok/body": () =>
        requestBody({ requestId: "req-ok", detailState: "none", artifact: null, sizeBytes: 0 }),
    });
    renderWithProviders(<LogsBoard />);

    await user.click(await screen.findByText("fast"));
    const dialog = await screen.findByRole("dialog");

    expect(await within(dialog).findByText("Not captured")).toBeTruthy();
    expect(within(dialog).getByText(/OMNI_BODY_LOGGING_ALLOWED/)).toBeTruthy();
  });

  test("an artifact that has been pruned reads as lost, not as never captured", async () => {
    const user = userEvent.setup();
    stubLogs({
      "GET /api/requests/req-ok/body": () =>
        requestBody({ requestId: "req-ok", detailState: "missing", artifact: null }),
    });
    renderWithProviders(<LogsBoard />);

    await user.click(await screen.findByText("fast"));
    const dialog = await screen.findByRole("dialog");

    expect(await within(dialog).findByText("Captured, then lost")).toBeTruthy();
    expect(within(dialog).queryByText("Not captured")).toBeNull();
  });

  test("an artifact that will not decrypt reads as unreadable, not as absent", async () => {
    const user = userEvent.setup();
    stubLogs({
      "GET /api/requests/req-ok/body": () =>
        requestBody({ requestId: "req-ok", detailState: "corrupt", artifact: null }),
    });
    renderWithProviders(<LogsBoard />);

    await user.click(await screen.findByText("fast"));
    const dialog = await screen.findByRole("dialog");

    expect(await within(dialog).findByText("Captured, but unreadable")).toBeTruthy();
    expect(within(dialog).getByText(/OMNI_ENCRYPTION_KEY/)).toBeTruthy();
  });

  /**
   * "Capture was off" and "capture ran and this was too big to keep" are the two
   * absences an operator most needs to tell apart, and they look identical
   * unless the omission marker is rendered as itself.
   */
  test("a body dropped for being too large says so rather than showing the marker", async () => {
    const user = userEvent.setup();
    stubLogs({
      "GET /api/requests/req-ok/body": () =>
        requestBody({
          requestId: "req-ok",
          truncated: true,
          artifact: bodyArtifact({
            client: {
              request: {
                omitted: true,
                reason: "artifact exceeded 524288 bytes after structural bounding",
                serializedBytes: 900_000,
              },
              response: null,
              truncated: true,
            },
            attempts: [],
          }),
        }),
    });
    renderWithProviders(<LogsBoard />);

    await user.click(await screen.findByText("fast"));
    const dialog = await screen.findByRole("dialog");

    expect(
      await within(dialog).findByText(/Too large to keep: artifact exceeded 524288 bytes/),
    ).toBeTruthy();
    expect(within(dialog).getByText(/900,000 bytes after structural bounding/)).toBeTruthy();
    expect(within(dialog).queryByText("Not captured")).toBeNull();
  });

  test("a truncated artifact is flagged rather than passed off as whole", async () => {
    const user = userEvent.setup();
    stubLogs({
      "GET /api/requests/req-ok/body": () =>
        requestBody({
          requestId: "req-ok",
          truncated: true,
          artifact: bodyArtifact({
            client: { request: { model: "fast" }, response: null, truncated: true },
            attempts: [],
          }),
        }),
    });
    renderWithProviders(<LogsBoard />);

    await user.click(await screen.findByText("fast"));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByText("truncated").length).toBeGreaterThan(0));
  });

  test("the artifact size says what it measured rather than reading as a request size", async () => {
    const user = userEvent.setup();
    stubLogs({
      "GET /api/requests/req-ok/body": () =>
        requestBody({
          requestId: "req-ok",
          sizeBytes: 82_400,
          artifact: bodyArtifact({
            client: { request: { model: "fast" }, response: { ok: true }, truncated: false },
            attempts: [],
          }),
        }),
    });
    renderWithProviders(<LogsBoard />);

    await user.click(await screen.findByText("fast"));
    const dialog = await screen.findByRole("dialog");
    // The figure is the encrypted file: bounded and masked, then hex encoded. It
    // is neither the wire size nor the size of the JSON shown below it, and a
    // bare number here would be read as the former.
    expect(await within(dialog).findByText(/82,400 bytes on disk/)).toBeTruthy();
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
