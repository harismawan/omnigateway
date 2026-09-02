import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConsoleBoard } from "../../src/features/console/ConsoleBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const FIRST_LINE = {
  raw: "2026-08-09T04:12:03.114Z INFO  omnigateway listening  port=9000",
  at: 1_786_000_323_114,
  level: "info",
  msg: "omnigateway listening",
};

const LINES = [
  FIRST_LINE,
  {
    raw: "2026-08-09T04:12:04.000Z ERROR quota poll failed  reason=boom",
    at: 1_786_000_324_000,
    level: "error",
    msg: "quota poll failed",
  },
];

/** The three answers the gateway can give about where its output went. */
function stubConsole(body: unknown) {
  return createFetchStub({ "GET /api/console": () => body as Record<string, unknown> });
}

describe("ConsoleBoard", () => {
  test("shows each line as it was printed", async () => {
    stubConsole({ source: "file", path: "/var/log/omni.log", lines: LINES });
    renderWithProviders(<ConsoleBoard />);

    // Whitespace is collapsed by the query, not by the page: the line is
    // rendered verbatim inside a <pre>.
    expect(await screen.findByText(/omnigateway listening port=9000/)).toBeTruthy();
    expect(screen.getByText(/quota poll failed reason=boom/)).toBeTruthy();
  });

  test("names the file it is reading, and the variable that points elsewhere", async () => {
    stubConsole({ source: "file", path: "/var/log/omni.log", lines: LINES });
    renderWithProviders(<ConsoleBoard />);

    expect(await screen.findByText("/var/log/omni.log")).toBeTruthy();
    expect(screen.getByText("OMNI_LOG_FILE")).toBeTruthy();
    // The variable names where output is captured; it does not redirect it,
    // and saying otherwise sends operators to set it and wonder why nothing
    // appears.
    expect(screen.getByText(/does not redirect it/)).toBeTruthy();
  });

  test("says when it is reading the journal, and how to read a file instead", async () => {
    stubConsole({ source: "journal", lines: LINES });
    renderWithProviders(<ConsoleBoard />);

    expect(await screen.findByText("omnigateway.service")).toBeTruthy();
    expect(screen.getByText(/redirect the gateway's output/)).toBeTruthy();
  });

  test("explains an uncaptured gateway rather than showing an empty log", async () => {
    stubConsole({ source: "none", lines: [] });
    renderWithProviders(<ConsoleBoard />);

    expect(await screen.findByText("Nothing is capturing this gateway")).toBeTruthy();
    expect(screen.getByText(/omni service install/)).toBeTruthy();
    expect(screen.getByText(/omni start/)).toBeTruthy();
  });

  test("distinguishes a quiet log from one filtered to nothing", async () => {
    const stub = stubConsole({ source: "file", path: "/var/log/omni.log", lines: [] });
    renderWithProviders(<ConsoleBoard />);

    expect(await screen.findByText(/This log is empty/)).toBeTruthy();

    stub.set("GET /api/console", () => ({ source: "file", path: "/var/log/omni.log", lines: [] }));
    await userEvent.selectOptions(screen.getByLabelText("Which levels to show"), "error");

    expect(await screen.findByText(/No line in this window is at that level/)).toBeTruthy();
  });

  test("asks the gateway for the level the operator chose", async () => {
    const stub = stubConsole({ source: "file", path: "/var/log/omni.log", lines: LINES });
    renderWithProviders(<ConsoleBoard />);
    await screen.findByText(/omnigateway listening/);

    await userEvent.selectOptions(screen.getByLabelText("Which levels to show"), "warn");

    await waitFor(() => {
      expect(stub.calls.some((call) => call.url.includes("level=warn"))).toBe(true);
    });
  });

  test("asks for the page size the operator chose", async () => {
    const stub = stubConsole({ source: "file", path: "/var/log/omni.log", lines: LINES });
    renderWithProviders(<ConsoleBoard />);
    await screen.findByText(/omnigateway listening/);

    await userEvent.selectOptions(screen.getByLabelText("How many lines to fetch"), "500");

    await waitFor(() => {
      expect(stub.calls.some((call) => call.url.includes("lines=500"))).toBe(true);
    });
  });

  test("reports a failed read instead of showing an empty console", async () => {
    createFetchStub({ "GET /api/console": () => ({ status: 500, body: { error: "boom" } }) });
    renderWithProviders(<ConsoleBoard />);

    expect(await screen.findByRole("button", { name: /try again/i })).toBeTruthy();
  });

  test("keeps the process header and source outside the terminal scroller", async () => {
    stubConsole({ source: "file", path: "/var/log/omni.log", lines: LINES });
    renderWithProviders(<ConsoleBoard />);

    const terminal = await screen.findByTestId("console-terminal");
    expect(terminal.contains(screen.getByText("Process output"))).toBe(false);
    expect(terminal.contains(screen.getByText("/var/log/omni.log"))).toBe(false);
  });

  test("bounds the terminal and initially scrolls to the latest line", async () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 500,
    });
    stubConsole({ source: "file", path: "/var/log/omni.log", lines: LINES });
    renderWithProviders(<ConsoleBoard />);

    const terminal = await screen.findByTestId("console-terminal");
    await act(async () => {});

    expect(getComputedStyle(terminal).overflowY).toBe("auto");
    expect(terminal.scrollTop).toBe(500);
    if (scrollHeight !== undefined) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
    }
  });

  test("follows refreshes only while the operator is near the bottom", async () => {
    let current = { source: "file", path: "/var/log/omni.log", lines: LINES };
    const stub = createFetchStub({ "GET /api/console": () => current });
    const rendered = renderWithProviders(<ConsoleBoard />);
    const terminal = await screen.findByTestId("console-terminal");
    Object.defineProperties(terminal, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => (current.lines.length > 2 ? 700 : 500) },
    });

    terminal.scrollTop = 400;
    fireEvent.scroll(terminal);
    current = { ...current, lines: [...LINES, { ...FIRST_LINE, raw: "new latest" }] };
    await rendered.client.invalidateQueries({ queryKey: ["console"] });
    await screen.findByText("new latest");
    expect(terminal.scrollTop).toBe(700);

    terminal.scrollTop = 100;
    fireEvent.scroll(terminal);
    current = {
      ...current,
      lines: [...current.lines, { ...FIRST_LINE, raw: "another latest" }],
    };
    await rendered.client.invalidateQueries({ queryKey: ["console"] });
    await screen.findByText("another latest");
    expect(terminal.scrollTop).toBe(100);
    expect(stub.calls.length).toBeGreaterThan(1);
  });
});

describe("ConsoleBoard source hint visibility", () => {
  test("names the file even when it is empty", async () => {
    // "Empty log" and "wrong log" look identical without this, which is why
    // the hint does not live in the has-rows branch.
    stubConsole({ source: "file", path: "/var/log/omni.log", lines: [] });
    renderWithProviders(<ConsoleBoard />);

    expect(await screen.findByText(/This log is empty/)).toBeTruthy();
    expect(screen.getByText("/var/log/omni.log")).toBeTruthy();
  });

  test("names the journal even when it is empty", async () => {
    stubConsole({ source: "journal", lines: [] });
    renderWithProviders(<ConsoleBoard />);

    expect(await screen.findByText(/This log is empty/)).toBeTruthy();
    expect(screen.getByText("omnigateway.service")).toBeTruthy();
  });

  test("keeps naming the source when a filter matches nothing", async () => {
    const stub = stubConsole({ source: "file", path: "/var/log/omni.log", lines: LINES });
    renderWithProviders(<ConsoleBoard />);
    await screen.findByText(/omnigateway listening/);

    stub.set("GET /api/console", () => ({ source: "file", path: "/var/log/omni.log", lines: [] }));
    await userEvent.selectOptions(screen.getByLabelText("Which levels to show"), "error");

    expect(await screen.findByText(/No line in this window is at that level/)).toBeTruthy();
    expect(screen.getByText("/var/log/omni.log")).toBeTruthy();
  });

  /**
   * The advice for an uncaptured fleet is not the single-process advice with
   * more words: `omni service install` is a machine's answer, and a fleet's is
   * a collector outside it. Pinned because the wrong one reads as usable.
   */
  test("points an uncaptured fleet at a collector, not at systemd", async () => {
    createFetchStub({
      "GET /api/console": () => ({ source: "none", lines: [] }),
      "GET /api/nodes": () => ({
        nodes: [
          { id: "aaaaaaaa-1", seenAt: 2, self: true },
          { id: "bbbbbbbb-2", seenAt: 1, self: false },
        ],
      }),
    });
    renderWithProviders(<ConsoleBoard />);

    expect(await screen.findByText("Nothing is capturing this gateway")).toBeTruthy();
    expect(screen.getByText(/Elasticsearch and Kibana/)).toBeTruthy();
    expect(screen.queryByText(/omni service install/)).toBeNull();
  });

  /**
   * A fleet shows a process selector, defaults to every process merged, and
   * asks for the chosen one by name. A single process shows no selector at
   * all — the control would offer a choice of one.
   */
  test("a fleet gets a process selector; one process does not", async () => {
    const single = createFetchStub({
      "GET /api/console": () => ({ source: "file", path: "/var/log/omni.log", lines: LINES }),
      "GET /api/nodes": () => ({ nodes: [{ id: "aaaaaaaa-1", seenAt: 1, self: true }] }),
    });
    const { unmount } = renderWithProviders(<ConsoleBoard />);
    await screen.findByText(/omnigateway listening/);
    expect(screen.queryByLabelText("Which process to show")).toBeNull();
    expect(single.calls.some((call) => call.url.includes("node="))).toBe(false);
    unmount();

    const fleet = createFetchStub({
      "GET /api/console": ({ url }) =>
        url.includes("node=bbbbbbbb")
          ? { source: "file", path: "/var/log/b.log", lines: [FIRST_LINE] }
          : {
              source: "fleet",
              lines: LINES.map((line) => ({ ...line, nodeId: "aaaaaaaa-1" })),
            },
      "GET /api/nodes": () => ({
        nodes: [
          { id: "aaaaaaaa-1", seenAt: 2, self: true },
          { id: "bbbbbbbb-2", seenAt: 1, self: false },
        ],
      }),
    });
    renderWithProviders(<ConsoleBoard />);
    const selector = await screen.findByLabelText("Which process to show");
    expect(await screen.findByText("every process, merged")).toBeTruthy();
    expect(await screen.findByText(/\[aaaaaaaa\] .*omnigateway listening/)).toBeTruthy();
    expect(fleet.calls.some((call) => call.url.includes("node=all"))).toBe(true);

    await userEvent.selectOptions(selector, "bbbbbbbb-2");
    expect(await screen.findByText("/var/log/b.log")).toBeTruthy();
    expect(fleet.calls.some((call) => call.url.includes("node=bbbbbbbb-2"))).toBe(true);
  });
});
