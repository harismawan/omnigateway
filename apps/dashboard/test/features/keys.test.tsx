import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KeysBoard } from "../../src/features/keys/KeysBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { apiKey, model } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const minted = {
  id: "key-9",
  label: "ci-runner",
  prefix: "omni_sk_zzzz",
  key: "omni_sk_zzzz_the_only_copy",
};

function stubKeys(overrides: Parameters<typeof createFetchStub>[0] = {}) {
  return createFetchStub({
    "GET /api/keys": () => ({
      keys: [
        apiKey(),
        apiKey({
          id: "key-2",
          label: "ci",
          prefix: "omni_sk_c3d4",
          modelAllowlist: ["fast"],
          limits: {},
        }),
        apiKey({
          id: "key-3",
          label: "retired",
          prefix: "omni_sk_e5f6",
          modelAllowlist: [],
          revokedAt: 1,
        }),
      ],
    }),
    "GET /api/models": () => ({ models: [model(), model({ id: "deep" })] }),
    ...overrides,
  });
}

describe("KeysBoard", () => {
  test("distinguishes unrestricted, restricted, and locked-out keys", async () => {
    stubKeys();
    renderWithProviders(<KeysBoard />);

    expect(await screen.findByText("2 active keys of 3 ever issued.")).toBeTruthy();
    expect(screen.getByText("every model")).toBeTruthy();
    expect(screen.getByText("no models")).toBeTruthy();
    expect(screen.getByText("omni_sk_a1b2…")).toBeTruthy();
  });

  test("a revoked key keeps its row but loses its action", async () => {
    stubKeys();
    renderWithProviders(<KeysBoard />);

    expect(await screen.findByText("revoked")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(2);
  });

  test("creating a key sends the label, allowlist, and limits", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({ "POST /api/keys": () => minted });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: /Create a key/ }));
    const dialog = await screen.findByRole("dialog");

    await user.type(within(dialog).getByLabelText("Label"), "ci-runner");
    await user.click(within(dialog).getByRole("button", { name: "Limits" }));
    await user.type(within(dialog).getByLabelText("Requests per minute"), "60");
    await user.type(within(dialog).getByLabelText("Spend per week"), "25.5");
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));

    await waitFor(() => {
      const post = stub.calls.find((call) => call.init?.method === "POST");
      expect(post?.init?.body).toBe(
        JSON.stringify({
          label: "ci-runner",
          modelAllowlist: null,
          limits: { requests: { "1m": 60 }, spend: { "1w": 25.5 } },
          bodyLoggingOptOut: false,
        }),
      );
    });
  });

  /**
   * Nine ceilings unfolded over an operator who only ever wanted a label would
   * be a worse default than the one field this replaced.
   */
  test("the limit matrix is folded away until it is asked for", async () => {
    const user = userEvent.setup();
    stubKeys();
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: /Create a key/ }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).queryByLabelText("Requests per minute")).toBeNull();
    expect(within(dialog).getByText("no limits; this key is unbounded")).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Limits" }));
    expect(within(dialog).getByLabelText("Requests per minute")).toBeTruthy();
  });

  /**
   * A key issued on the promise that its payloads are never retained. The
   * promise is made at creation and there is no route that takes it back, so the
   * dialog is where it has to be settable and the list is where it has to show.
   */
  test("a key can be issued that is never captured, and the choice is sent", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({ "POST /api/keys": () => minted });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: /Create a key/ }));
    const dialog = await screen.findByRole("dialog");

    await user.type(within(dialog).getByLabelText("Label"), "private-client");
    await user.click(
      within(dialog).getByRole("switch", { name: "Never record this key's bodies" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));

    await waitFor(() => {
      const post = stub.calls.find((call) => call.init?.method === "POST");
      const body = JSON.parse(String(post?.init?.body)) as { bodyLoggingOptOut: unknown };
      expect(body.bodyLoggingOptOut).toBe(true);
    });
  });

  test("a blank rate limit submits an empty matrix rather than a null inside one", async () => {
    // `{}` is unlimited, and so is an omitted pair. Sending
    // `{ requests: { "1m": null } }` would say the same thing in a second
    // spelling that every reader then has to handle.
    const user = userEvent.setup();
    const stub = stubKeys({ "POST /api/keys": () => minted });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: /Create a key/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Label"), "unbounded");
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));

    await waitFor(() => {
      const post = stub.calls.find((call) => call.init?.method === "POST");
      const body = JSON.parse(String(post?.init?.body)) as { limits: unknown };
      expect(body.limits).toEqual({});
    });
  });

  test("an opted-out key is listed as such rather than looking like any other", async () => {
    stubKeys({
      "GET /api/keys": () => ({
        keys: [apiKey(), apiKey({ id: "key-2", label: "private", bodyLoggingOptOut: true })],
      }),
    });
    renderWithProviders(<KeysBoard />);

    const row = (await screen.findByText("private")).closest("tr");
    if (row === null) throw new Error("the opted-out key has no row");
    expect(within(row).getByText("no bodies")).toBeTruthy();

    const ordinary = screen.getByText("laptop").closest("tr");
    if (ordinary === null) throw new Error("the ordinary key has no row");
    expect(within(ordinary).queryByText("no bodies")).toBeNull();
  });

  /**
   * `null` limits mean the gateway cannot read what is stored and refuses the
   * key. Rendering that as the dash used for "no limits" would put the one row
   * needing attention next to the ones that need none.
   */
  test("a key whose limits cannot be read is shown as broken rather than unlimited", async () => {
    stubKeys({
      "GET /api/keys": () => ({
        keys: [apiKey(), apiKey({ id: "key-2", label: "meddled", limits: null })],
      }),
    });
    renderWithProviders(<KeysBoard />);

    const row = (await screen.findByText("meddled")).closest("tr");
    if (row === null) throw new Error("the unreadable key has no row");
    expect(within(row).getByText("unreadable")).toBeTruthy();

    // The healthy key keeps its own ceiling: one broken row is one broken row.
    const ordinary = screen.getByText("laptop").closest("tr");
    if (ordinary === null) throw new Error("the ordinary key has no row");
    expect(within(ordinary).getByText("1 limit")).toBeTruthy();
    expect(within(ordinary).queryByText("unreadable")).toBeNull();
  });

  test("the raw key is shown once, with a warning that it is the only copy", async () => {
    const user = userEvent.setup();
    stubKeys({ "POST /api/keys": () => minted });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: /Create a key/ }));
    await user.click(await screen.findByRole("button", { name: "Create key" }));

    expect(await screen.findByText(minted.key)).toBeTruthy();
    expect(screen.getByText(/only time the key is shown/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy API key" })).toBeTruthy();
  });

  test("restricting to no model warns that the key is allowed nothing", async () => {
    const user = userEvent.setup();
    stubKeys();
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: /Create a key/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByLabelText("Allow every model"));

    expect(
      await within(dialog).findByText(
        /this key is allowed nothing and every request it makes will be refused/i,
      ),
    ).toBeTruthy();
  });

  test("a fractional request ceiling is refused before it is sent", async () => {
    const user = userEvent.setup();
    const stub = stubKeys();
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: /Create a key/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Limits" }));
    await user.type(within(dialog).getByLabelText("Requests per minute"), "1.5");
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Requests per minute must be a whole number above zero, or blank for no limit.",
    );
    expect(stub.calls.some((call) => call.init?.method === "POST")).toBe(false);
  });

  /**
   * Zero is not a ceiling of zero, it is a key that can do nothing — and it is
   * a whole number and a finite one, so the integer check beside it never sees
   * it. Refused here rather than at the route, because here it can name the
   * field the operator typed into.
   */
  test("a ceiling of zero is refused before it is sent", async () => {
    const user = userEvent.setup();
    const stub = stubKeys();
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: /Create a key/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Limits" }));
    await user.type(within(dialog).getByLabelText("Requests per minute"), "0");
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Requests per minute must be a whole number above zero, or blank for no limit.",
    );
    expect(stub.calls.some((call) => call.init?.method === "POST")).toBe(false);
  });

  test("revoking says the key cannot be brought back", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({ "DELETE /api/keys/key-1": () => ({ ok: true }) });
    renderWithProviders(<KeysBoard />);

    const revoke = await screen.findAllByRole("button", { name: "Revoke" });
    await user.click(revoke[0] as HTMLElement);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/cannot be un-revoked/i)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Revoke key" }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.url === "/api/keys/key-1")).toBe(true);
    });
  });

  /**
   * A key has one cell and may have three ceilings, so the summary has to pick
   * one. The shortest window is the wrong answer and so is the first
   * configured: a key idle this minute and one request from its weekly ceiling
   * would read as comfortable in either.
   */
  test("the cell summarises the count and the limit nearest exhaustion", async () => {
    stubKeys({
      "GET /api/keys": () => ({
        keys: [
          apiKey({
            limits: { requests: { "1m": 60 }, tokens: { "1w": 1_000_000 } },
            limitUsage: [
              { dimension: "requests", window: "1m", limit: 60, used: 6 },
              { dimension: "tokens", window: "1w", limit: 1_000_000, used: 900_000 },
            ],
          }),
        ],
      }),
    });
    renderWithProviders(<KeysBoard />);

    const row = (await screen.findByText("laptop")).closest("tr");
    if (row === null) throw new Error("the key has no row");
    expect(within(row).getByText("2 limits")).toBeTruthy();
    expect(within(row).getByText("Tokens per week 1,000,000, 90% used")).toBeTruthy();
    expect(within(row).queryByText(/Requests per minute/)).toBeNull();
  });

  /**
   * Both ceilings are already passed, so a share clamped to 100% cannot tell
   * them apart and the summary falls back to whichever was walked first.
   *
   * Being over a ceiling is ordinary rather than exceptional: `tokens` and
   * `spend` debit once a response completes, so a key finishes one request past
   * either of them. The row that most needs attention is the one furthest past,
   * and 500% over is a different situation from 10% over.
   */
  test("the cell separates two ceilings that are both already passed", async () => {
    stubKeys({
      "GET /api/keys": () => ({
        keys: [
          apiKey({
            limits: { requests: { "1m": 60 }, tokens: { "1w": 1_000 } },
            limitUsage: [
              { dimension: "requests", window: "1m", limit: 60, used: 66 },
              { dimension: "tokens", window: "1w", limit: 1_000, used: 5_000 },
            ],
          }),
        ],
      }),
    });
    renderWithProviders(<KeysBoard />);

    const row = (await screen.findByText("laptop")).closest("tr");
    if (row === null) throw new Error("the key has no row");
    expect(within(row).getByText("Tokens per week 1,000, 500% used")).toBeTruthy();
    expect(within(row).queryByText(/Requests per minute/)).toBeNull();
  });

  test("the full matrix is behind a disclosure rather than in the cell", async () => {
    const user = userEvent.setup();
    stubKeys({
      "GET /api/keys": () => ({
        keys: [
          apiKey({
            limits: { requests: { "1m": 60 }, concurrency: 8 },
            limitUsage: [
              { dimension: "requests", window: "1m", limit: 60, used: 45 },
              { dimension: "concurrency", window: null, limit: 8, used: null },
            ],
          }),
        ],
      }),
    });
    renderWithProviders(<KeysBoard />);

    const toggle = await screen.findByRole("button", { name: "Show limits for laptop" });
    expect(screen.queryByRole("meter")).toBeNull();

    await user.click(toggle);
    expect(
      await screen.findByRole("meter", { name: "laptop, Requests per minute, 75% used" }),
    ).toBeTruthy();
    // A gauge held in the serving process has no bar to draw, and drawing an
    // empty one would claim the key is idle.
    expect(screen.getAllByRole("meter")).toHaveLength(1);
    expect(screen.getByText(/in flight now, counted in the gateway process/)).toBeTruthy();
  });

  /**
   * Editable after creation, unlike `bodyLoggingOptOut`. A weekly spend cap that
   * cannot be adjusted without minting a new key and redeploying every client is
   * a cap that gets set to unlimited instead.
   */
  test("limits are editable after creation, and the matrix is sent whole", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({
        keys: [apiKey({ limits: { requests: { "1m": 60 }, tokens: { "1w": 1_000_000 } } })],
      }),
      "PUT /api/keys/key-1/limits": () => apiKey(),
    });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: "Edit limits for laptop" }));
    const dialog = await screen.findByRole("dialog");

    // The stored matrix is what the form starts from, not a blank one.
    const perMinute = within(dialog).getByLabelText("Requests per minute");
    expect((perMinute as HTMLInputElement).value).toBe("60");

    await user.clear(perMinute);
    await user.type(perMinute, "90");
    await user.clear(within(dialog).getByLabelText("Tokens per week"));
    await user.click(within(dialog).getByRole("button", { name: "Save limits" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.url).toBe("/api/keys/key-1/limits");
      // Cleared, not merged: the whole matrix is sent, so a blank field is how
      // a ceiling is removed.
      expect(put?.init?.body).toBe(JSON.stringify({ limits: { requests: { "1m": 90 } } }));
    });
  });

  test("clearing every field leaves the key unlimited rather than broken", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({ keys: [apiKey({ limits: { requests: { "1m": 60 } } })] }),
      "PUT /api/keys/key-1/limits": () => apiKey({ limits: {} }),
    });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: "Edit limits for laptop" }));
    const dialog = await screen.findByRole("dialog");
    await user.clear(within(dialog).getByLabelText("Requests per minute"));
    await user.click(within(dialog).getByRole("button", { name: "Save limits" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.init?.body).toBe(JSON.stringify({ limits: {} }));
    });
  });

  test("with no keys the screen says what to do", async () => {
    createFetchStub({
      "GET /api/keys": () => ({ keys: [] }),
      "GET /api/models": () => ({ models: [] }),
    });
    renderWithProviders(<KeysBoard />);

    expect(
      await screen.findByText("No keys exist, so nothing can call this gateway yet."),
    ).toBeTruthy();
  });
});
