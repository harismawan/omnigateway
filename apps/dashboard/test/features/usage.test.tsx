import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageBoard } from "../../src/features/usage/UsageBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { apiKey, credential, usageBucket } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

function rowsFor(url: string) {
  if (url.includes("groupBy=hour")) {
    return { rows: [usageBucket({ key: "500000", requests: 10, errors: 1, costUsd: 0.5 })] };
  }
  if (url.includes("groupBy=apiKey")) {
    return { rows: [usageBucket({ key: "key-1", requests: 7, errors: 0, costUsd: 0.25 })] };
  }
  return {
    rows: [
      usageBucket({ key: "cred-1", requests: 40, errors: 2, costUsd: 3 }),
      usageBucket({ key: "cred-unknown", requests: 5, errors: 0, costUsd: 0.5 }),
    ],
  };
}

function stubUsage() {
  return createFetchStub({
    "GET /api/usage": ({ url }) => rowsFor(url),
    "GET /api/credentials": () => ({ credentials: [credential()] }),
    "GET /api/keys": () => ({ keys: [apiKey()] }),
  });
}

describe("UsageBoard", () => {
  test("opens on the time series and totals the window", async () => {
    stubUsage();
    renderWithProviders(<UsageBoard />);

    expect(await screen.findByText("10 requests and $0.50 over the last 24 hours.")).toBeTruthy();
    expect(screen.getByText("Hour")).toBeTruthy();
  });

  test("switching the grouping refetches and renames the key column", async () => {
    const user = userEvent.setup();
    const stub = stubUsage();
    renderWithProviders(<UsageBoard />);

    await screen.findByText("Hour");
    await user.click(screen.getByRole("button", { name: "By account" }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.url.includes("groupBy=credential"))).toBe(true);
    });
    expect(await screen.findByText("Account")).toBeTruthy();
  });

  test("names accounts and keys, and falls back to the raw id", async () => {
    const user = userEvent.setup();
    stubUsage();
    renderWithProviders(<UsageBoard />);

    await screen.findByText("Hour");
    await user.click(screen.getByRole("button", { name: "By account" }));

    expect(await screen.findByText("claude-main")).toBeTruthy();
    expect(screen.getByText("cred-unknown")).toBeTruthy();
  });

  test("changing the range moves the since bound", async () => {
    const user = userEvent.setup();
    const stub = stubUsage();
    renderWithProviders(<UsageBoard />);

    await screen.findByText("Hour");
    const before = stub.calls.filter((call) => call.url.startsWith("/api/usage")).length;
    await user.click(screen.getByRole("button", { name: "7d" }));

    await waitFor(() => {
      const after = stub.calls.filter((call) => call.url.startsWith("/api/usage"));
      expect(after.length).toBeGreaterThan(before);
    });
    expect(await screen.findByText(/over the last 7 days\.$/)).toBeTruthy();
  });

  test("an empty window says how to get data instead of drawing an empty chart", async () => {
    createFetchStub({
      "GET /api/usage": () => ({ rows: [] }),
      "GET /api/credentials": () => ({ credentials: [] }),
      "GET /api/keys": () => ({ keys: [] }),
    });
    renderWithProviders(<UsageBoard />);

    expect(
      await screen.findByText(
        "No requests landed in this window. Widen the range, or send traffic through the gateway.",
      ),
    ).toBeTruthy();
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

    expect(await screen.findByText("internal error")).toBeTruthy();
  });
});
