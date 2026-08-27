import { describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { ClientBoard } from "../../src/features/client/ClientBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { apiKey, log, usageBucket } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

function stub(over: Record<string, () => unknown> = {}) {
  return createFetchStub({
    "GET /api/client/summary": () => apiKey(),
    "GET /api/client/usage": () => [usageBucket({ key: "fast" })],
    "GET /api/client/logs": () => ({ logs: [log()] }),
    "GET /api/client/quota": () => ({ headroom: [] }),
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

  test("provider headroom renders without naming an account", async () => {
    stub({
      "GET /api/client/quota": () => ({
        headroom: [
          { provider: "anthropic", windowType: "fiveHour", usedRatio: 0.42, resetsAt: null },
        ],
      }),
    });
    const { container } = renderWithProviders(<ClientBoard />);

    // Anchored on the percentage, not on the provider name: "anthropic" is also
    // the provider of the seeded log row, so a bare text query matches two
    // tables and says nothing about which one rendered.
    const row = (await screen.findByText("42%")).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("anthropic")).toBeTruthy();
    expect(within(row as HTMLElement).getByText("fiveHour")).toBeTruthy();

    // No credential id reaches the DOM, which is the property the redaction is
    // for. Asserted on rendered text rather than on the fixture.
    expect(container.textContent).not.toContain("cred-");
  });

  test("headroom with no ceiling reads unknown, not zero", async () => {
    stub({
      "GET /api/client/quota": () => ({
        headroom: [{ provider: "openai", windowType: "weekly", usedRatio: null, resetsAt: null }],
      }),
    });
    renderWithProviders(<ClientBoard />);

    const row = (await screen.findByText("openai")).closest("tr");
    expect(within(row as HTMLElement).getByText("unknown")).toBeTruthy();
  });

  test("request rows carry metadata and no way to open a body", async () => {
    stub();
    const { container } = renderWithProviders(<ClientBoard />);
    await screen.findByText("laptop");
    // Both tables render the model name, so this waits for all of them rather
    // than asserting a uniqueness the fixtures do not have.
    expect((await screen.findAllByText("fast")).length).toBeGreaterThan(0);

    // There is no body route on this surface, so there must be nothing offering
    // to reach one.
    expect(container.textContent).not.toMatch(/body|prompt|payload/i);
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
        headroom: [
          { provider: "anthropic", windowType: "fiveHour", usedRatio: 0.62, resetsAt: null },
        ],
      }),
    });
    renderWithProviders(<ClientBoard />);

    const meter = await screen.findByRole("meter", { name: /anthropic fiveHour/i });
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
