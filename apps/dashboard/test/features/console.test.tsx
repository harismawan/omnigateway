import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConsoleBoard } from "../../src/features/console/ConsoleBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const LINES = [
  {
    raw: "2026-08-09T04:12:03.114Z INFO  omnigateway listening  port=9000",
    at: 1_786_000_323_114,
    level: "info",
    msg: "omnigateway listening",
  },
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
  });

  test("says when it is reading the journal, and how to read a file instead", async () => {
    stubConsole({ source: "journal", lines: LINES });
    renderWithProviders(<ConsoleBoard />);

    expect(await screen.findByText("omnigateway.service")).toBeTruthy();
    expect(screen.getByText("OMNI_LOG_FILE=/path/to/gateway.log")).toBeTruthy();
  });

  test("explains an uncaptured gateway rather than showing an empty log", async () => {
    stubConsole({ source: "none", lines: [] });
    renderWithProviders(<ConsoleBoard />);

    expect(await screen.findByText("Nothing is capturing this gateway")).toBeTruthy();
    expect(screen.getByText(/omni service install/)).toBeTruthy();
    expect(screen.getByText(/OMNI_LOG_FILE=\/path\/to\/gateway.log/)).toBeTruthy();
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
});
