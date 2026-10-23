import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KeysBoard } from "../../src/features/keys/KeysBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { apiKey, model, settings } from "../helpers/fixtures.ts";
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

  /** Like the request log: the key table scrolls inside its module, under the page head. */
  test("scrolls key rows inside the bounded keys module", async () => {
    stubKeys();
    renderWithProviders(<KeysBoard />);

    const table = await screen.findByRole("table");
    const scroller = table.parentElement;
    if (scroller === null) throw new Error("key table has no scroller");
    expect(getComputedStyle(scroller).overflowY).toBe("auto");
    const panel = scroller.closest("section");
    if (panel === null) throw new Error("key table sits in no module");
    expect(getComputedStyle(panel).flexGrow).toBe("1");
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
          // Blank means never, which is what a key that says nothing about
          // expiry has always meant.
          expiresAt: null,
        }),
      );
    });
  });

  /**
   * A native `datetime-local`, so what is typed is local wall time and what is
   * sent is the epoch instant it names.
   *
   * The claim here is the wiring — that the typed field reaches the body at all
   * — and the expectation is written out rather than recomputed through the
   * conversion under test. Whether the conversion lands the offset the right way
   * round is `features/keys/expiry.test.ts`, which runs it under fixed non-zero
   * zones; it cannot be asked here, because `bun test` pins this process to UTC
   * and every sign of a zero offset is the same number.
   */
  test("an expiry typed at creation is sent as the instant it names", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({ "POST /api/keys": () => minted });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: /Create a key/ }));
    const dialog = await screen.findByRole("dialog");

    await user.type(within(dialog).getByLabelText("Label"), "dated");
    await user.type(within(dialog).getByLabelText("Expires"), "2030-06-01T12:00");
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));

    await waitFor(() => {
      const post = stub.calls.find((call) => call.init?.method === "POST");
      const body = JSON.parse(String(post?.init?.body)) as { expiresAt: number };
      expect(body.expiresAt).toBe(Date.UTC(2030, 5, 1, 12, 0));
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
              { dimension: "requests", window: "1m", limit: 60, used: 6, model: null },
              { dimension: "tokens", window: "1w", limit: 1_000_000, used: 900_000, model: null },
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
              { dimension: "requests", window: "1m", limit: 60, used: 66, model: null },
              { dimension: "tokens", window: "1w", limit: 1_000, used: 5_000, model: null },
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
              { dimension: "requests", window: "1m", limit: 60, used: 45, model: null },
              { dimension: "concurrency", window: null, limit: 8, used: null, model: null },
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

  /**
   * An override nearer exhaustion than any key-wide ceiling is the one the cell
   * carries, and it says which model it belongs to: "Requests per minute 20"
   * alone would read as the whole key's ceiling.
   */
  test("the cell names the model when an override is nearest exhaustion", async () => {
    stubKeys({
      "GET /api/keys": () => ({
        keys: [
          apiKey({
            limits: { requests: { "1m": 60 }, models: { opus: { requests: { "1m": 20 } } } },
            limitUsage: [
              { dimension: "requests", window: "1m", limit: 60, used: 30, model: null },
              { dimension: "requests", window: "1m", limit: 20, used: 18, model: "opus" },
            ],
          }),
        ],
      }),
    });
    renderWithProviders(<KeysBoard />);

    const row = (await screen.findByText("laptop")).closest("tr");
    if (row === null) throw new Error("the key has no row");
    expect(within(row).getByText("2 limits")).toBeTruthy();
    expect(within(row).getByText("Requests per minute for opus 20, 90% used")).toBeTruthy();
  });

  test("the matrix groups an override's readings under its model", async () => {
    const user = userEvent.setup();
    stubKeys({
      "GET /api/keys": () => ({
        keys: [
          apiKey({
            limits: { requests: { "1m": 60 }, models: { opus: { requests: { "1m": 20 } } } },
            limitUsage: [
              { dimension: "requests", window: "1m", limit: 60, used: 30, model: null },
              { dimension: "requests", window: "1m", limit: 20, used: 18, model: "opus" },
            ],
          }),
        ],
      }),
    });
    renderWithProviders(<KeysBoard />);
    await user.click(await screen.findByRole("button", { name: "Show limits for laptop" }));

    const keyWide = await screen.findByRole("group", { name: "Every model" });
    const opus = screen.getByRole("group", { name: "opus" });
    expect(
      within(keyWide).getByRole("meter", { name: "laptop, Requests per minute, 50% used" }),
    ).toBeTruthy();
    expect(
      within(opus).getByRole("meter", { name: "laptop, opus, Requests per minute, 90% used" }),
    ).toBeTruthy();
    expect(within(keyWide).getAllByRole("meter")).toHaveLength(1);
  });

  test("a key with no overrides draws no model headings", async () => {
    const user = userEvent.setup();
    stubKeys({
      "GET /api/keys": () => ({ keys: [apiKey({ limits: { requests: { "1m": 60 } } })] }),
    });
    renderWithProviders(<KeysBoard />);
    await user.click(await screen.findByRole("button", { name: "Show limits for laptop" }));
    await screen.findByRole("meter");
    expect(screen.queryByRole("group", { name: "Every model" })).toBeNull();
  });

  /**
   * The round trip the section exists for: an existing override is shown and
   * edited, a new one is added, and the matrix goes back whole with the key-wide
   * limits untouched beside them.
   */
  test("per-model overrides are edited, added, and sent whole with the key's limits", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({
        keys: [
          apiKey({
            limits: { requests: { "1m": 60 }, models: { opus: { requests: { "1m": 20 } } } },
          }),
        ],
      }),
      "PUT /api/keys/key-1/limits": () => apiKey(),
    });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: "Edit limits for laptop" }));
    const dialog = await screen.findByRole("dialog");
    const opus = within(dialog).getByRole("group", { name: "Override for opus" });
    const opusMinute = within(opus).getByLabelText("Requests per minute");
    expect((opusMinute as HTMLInputElement).value).toBe("20");
    await user.clear(opusMinute);
    await user.type(opusMinute, "10");

    await user.click(within(dialog).getByRole("button", { name: "Add model override" }));
    const added = within(dialog).getByRole("group", { name: "Override for a new model" });
    await user.type(within(added).getByLabelText("Model"), "llama3:8b");
    const named = within(dialog).getByRole("group", { name: "Override for llama3:8b" });
    await user.type(within(named).getByLabelText("Concurrent"), "2");

    await user.click(within(dialog).getByRole("button", { name: "Save limits" }));
    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.init?.body).toBe(
        JSON.stringify({
          limits: {
            requests: { "1m": 60 },
            models: { opus: { requests: { "1m": 10 } }, "llama3:8b": { concurrency: 2 } },
          },
        }),
      );
    });
  });

  test("removing the last override sends the matrix without `models`", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({
        keys: [
          apiKey({ limits: { requests: { "1m": 60 }, models: { opus: { concurrency: 1 } } } }),
        ],
      }),
      "PUT /api/keys/key-1/limits": () => apiKey(),
    });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: "Edit limits for laptop" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove override for opus" }));
    expect(within(dialog).queryByRole("group", { name: "Override for opus" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Save limits" }));
    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.init?.body).toBe(JSON.stringify({ limits: { requests: { "1m": 60 } } }));
    });
  });

  test("an override with no model, no limit, or a model twice is refused before it is sent", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({
        keys: [apiKey({ limits: { models: { opus: { concurrency: 1 } } } })],
      }),
      "PUT /api/keys/key-1/limits": () => apiKey(),
    });
    renderWithProviders(<KeysBoard />);
    await user.click(await screen.findByRole("button", { name: "Edit limits for laptop" }));
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save limits" });

    await user.click(within(dialog).getByRole("button", { name: "Add model override" }));
    await user.click(save);
    expect((await within(dialog).findByRole("alert")).textContent).toContain("needs a model");

    const added = within(dialog).getByRole("group", { name: "Override for a new model" });
    await user.type(within(added).getByLabelText("Model"), "deep");
    await user.click(save);
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "The override for deep sets no limit",
    );

    const deep = within(dialog).getByRole("group", { name: "Override for deep" });
    await user.clear(within(deep).getByLabelText("Model"));
    await user.type(within(deep).getByLabelText("Model"), "opus");
    await user.click(save);
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "opus is overridden twice",
    );

    const second = within(dialog).getAllByRole("group", { name: "Override for opus" })[1];
    if (second === undefined) throw new Error("expected the second opus override");
    await user.clear(within(second).getByLabelText("Model"));
    await user.type(within(second).getByLabelText("Model"), "deep");
    await user.type(within(second).getByLabelText("Requests per minute"), "1.5");
    await user.click(save);
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "deep: Requests per minute must be a whole number",
    );
    expect(stub.calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  /**
   * A model name is matched exactly, so a name typed with a stray space would
   * be an override that never applies. It is refused rather than trimmed: a
   * trim would silently rename the override the operator sees.
   */
  test("a typed model name with surrounding spaces is refused, not trimmed", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({ keys: [apiKey({ limits: {} })] }),
      "PUT /api/keys/key-1/limits": () => apiKey(),
    });
    renderWithProviders(<KeysBoard />);
    await user.click(await screen.findByRole("button", { name: "Edit limits for laptop" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Add model override" }));
    const added = within(dialog).getByRole("group", { name: "Override for a new model" });
    await user.type(within(added).getByLabelText("Model"), "deep ");
    await user.type(within(added).getByLabelText("Concurrent"), "2");
    await user.click(within(dialog).getByRole("button", { name: "Save limits" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("spaces around it");
    expect(stub.calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  /**
   * The other half of not trimming: a stored name the API accepted with a space
   * in it goes back exactly as it came, so an unrelated edit neither renames it
   * nor becomes unsavable over it.
   */
  test("a stored override keeps its exact name through an unrelated edit", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({
        keys: [
          apiKey({ limits: { requests: { "1m": 60 }, models: { " opus": { concurrency: 1 } } } }),
        ],
      }),
      "PUT /api/keys/key-1/limits": () => apiKey(),
    });
    renderWithProviders(<KeysBoard />);
    await user.click(await screen.findByRole("button", { name: "Edit limits for laptop" }));
    const dialog = await screen.findByRole("dialog");
    const perMinute = within(dialog).getAllByLabelText("Requests per minute")[0];
    if (perMinute === undefined) throw new Error("no key-wide field");
    await user.clear(perMinute);
    await user.type(perMinute, "90");
    await user.click(within(dialog).getByRole("button", { name: "Save limits" }));
    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.init?.body).toBe(
        JSON.stringify({
          limits: { requests: { "1m": 90 }, models: { " opus": { concurrency: 1 } } },
        }),
      );
    });
  });

  /**
   * An override on a model the key cannot call is harmless and stays savable,
   * so it is a hint rather than an error: refusing it would make unrelated edits
   * unsavable the day a model is renamed.
   */
  test("an override the allowlist excludes is hinted, and still saved", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({
        keys: [
          apiKey({
            modelAllowlist: ["fast"],
            limits: { models: { opus: { concurrency: 1 }, fast: { concurrency: 2 } } },
          }),
        ],
      }),
      "PUT /api/keys/key-1/limits": () => apiKey(),
    });
    renderWithProviders(<KeysBoard />);
    await user.click(await screen.findByRole("button", { name: "Edit limits for laptop" }));
    const dialog = await screen.findByRole("dialog");

    const opus = within(dialog).getByRole("group", { name: "Override for opus" });
    expect(within(opus).getByText(/not in this key's allowed models/)).toBeTruthy();
    const fast = within(dialog).getByRole("group", { name: "Override for fast" });
    expect(within(fast).queryByText(/not in this key's allowed models/)).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Save limits" }));
    await waitFor(() => {
      expect(stub.calls.some((call) => call.init?.method === "PUT")).toBe(true);
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

  /**
   * Editable after creation, like limits: an allowlist that cannot be adjusted
   * without minting a new key and redeploying every client is one that gets set
   * to unrestricted instead. The stored list is what the form starts from, and
   * a named model that is no longer configured stays checked — dropping it
   * silently would widen the key without anyone deciding to.
   */
  test("allowed models are editable after creation, and the list is sent whole", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({
        keys: [apiKey({ modelAllowlist: ["fast", "legacy"], limits: {} })],
      }),
      "PUT /api/keys/key-1/models": () => apiKey(),
    });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: "Edit models for laptop" }));
    const dialog = await screen.findByRole("dialog");

    // Both configured models and the stale one render; the stored two start
    // checked and the merely-available one does not.
    expect(
      (within(dialog).getByRole("checkbox", { name: "fast" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(dialog).getByRole("checkbox", { name: "legacy" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(dialog).getByRole("checkbox", { name: "deep" }) as HTMLInputElement).checked,
    ).toBe(false);

    await user.click(within(dialog).getByRole("checkbox", { name: "deep" }));
    await user.click(within(dialog).getByRole("button", { name: "Save models" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.url).toBe("/api/keys/key-1/models");
      // Sent whole, stale entry included: the gateway stores one document.
      expect(put?.init?.body).toBe(JSON.stringify({ modelAllowlist: ["fast", "legacy", "deep"] }));
    });
  });

  /**
   * `null` and `[]` are opposite facts, and the dialog carries both spellings:
   * the toggle restores every model, clearing every box denies all of them.
   */
  test("the every-model toggle sends null rather than an empty list", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({ keys: [apiKey({ modelAllowlist: ["fast"], limits: {} })] }),
      "PUT /api/keys/key-1/models": () => apiKey(),
    });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: "Edit models for laptop" }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("switch", { name: "Allow every model" }));
    await user.click(within(dialog).getByRole("button", { name: "Save models" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.init?.body).toBe(JSON.stringify({ modelAllowlist: null }));
    });
  });

  /**
   * An expired key keeps its row.
   *
   * A key that stopped working and then vanished from the board is the bug this
   * feature would otherwise ship: the operator sees a client failing and finds
   * nothing on the screen that says why. It stays listed, with a state of its
   * own — neither "active", which would be a lie, nor "revoked", which is a
   * different and irreversible thing — and only the headline count narrows.
   */
  test("an expired key stays listed with its own state and date, and is not counted active", async () => {
    stubKeys({
      "GET /api/keys": () => ({
        keys: [
          apiKey(),
          apiKey({ id: "key-2", label: "lapsed", expiresAt: 1_000_000_000_000 }),
          apiKey({ id: "key-3", label: "dated", expiresAt: Date.now() + 86_400_000 }),
        ],
      }),
    });
    renderWithProviders(<KeysBoard />);

    const lapsed = (await screen.findByText("lapsed")).closest("tr");
    if (lapsed === null) throw new Error("the expired key lost its row");
    expect(within(lapsed).getByText("expired")).toBeTruthy();
    expect(within(lapsed).queryByText("active")).toBeNull();

    // Still ahead of the clock, so it is active and says when it will not be.
    const dated = screen.getByText("dated").closest("tr");
    if (dated === null) throw new Error("the dated key has no row");
    expect(within(dated).getByText("active")).toBeTruthy();
    expect(within(dated).getByText(/^expires /)).toBeTruthy();

    expect(screen.getByText("2 active keys of 3 ever issued.")).toBeTruthy();
  });

  /**
   * The way back from an expiry, which revocation deliberately does not have.
   *
   * Reachable on an already-expired key, and `null` is sent rather than the
   * field being omitted — an absent field is a `BAD_REQUEST`, because saying
   * nothing and saying "never" are different instructions.
   */
  test("an expiry is editable after creation and clearable back to never", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({ keys: [apiKey({ expiresAt: 1_000_000_000_000 })] }),
      "PUT /api/keys/key-1/expiry": () => apiKey(),
    });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: "Edit expiry for laptop" }));
    const dialog = await screen.findByRole("dialog");

    // The stored instant is what the field starts from. Written out, for the
    // reason given on the creation test above: under this runner's UTC the
    // offset is zero, so recomputing it here would agree with any sign.
    const field = within(dialog).getByLabelText("Expires") as HTMLInputElement;
    expect(field.value).toBe("2001-09-09T01:46");
    expect(within(dialog).getByRole("status").textContent).toContain("expired");

    await user.clear(field);
    await user.click(within(dialog).getByRole("button", { name: "Save expiry" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.url).toBe("/api/keys/key-1/expiry");
      expect(put?.init?.body).toBe(JSON.stringify({ expiresAt: null }));
    });
  });

  test("a new expiry is sent as the instant the field names", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({ keys: [apiKey()] }),
      "PUT /api/keys/key-1/expiry": () => apiKey({ expiresAt: 1 }),
    });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: "Edit expiry for laptop" }));
    const dialog = await screen.findByRole("dialog");
    // Nothing set, so nothing to say about a lapse.
    expect(within(dialog).queryByRole("status")).toBeNull();

    await user.type(within(dialog).getByLabelText("Expires"), "2031-03-04T05:06");
    await user.click(within(dialog).getByRole("button", { name: "Save expiry" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.init?.body).toBe(JSON.stringify({ expiresAt: Date.UTC(2031, 2, 4, 5, 6) }));
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

describe("usage policy", () => {
  test("a policy is written, sent whole, and the board says the key is judged", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({ keys: [apiKey()] }),
      "GET /api/settings": () => ({
        settings: { ...settings, guardrailModel: "judge" },
        bodyLoggingAllowed: false,
      }),
      "PUT /api/keys/key-1/guardrail": () => apiKey({ guardrailPolicy: "Work only." }),
    });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: "Edit usage policy for laptop" }));
    const dialog = await screen.findByRole("dialog");
    // The threat model, said once and plainly.
    expect(within(dialog).getByText(/not a security boundary/)).toBeTruthy();
    // No policy yet, so there is nothing to remove.
    expect(within(dialog).queryByRole("button", { name: "Remove policy" })).toBeNull();

    const field = within(dialog).getByLabelText("Policy");
    await user.type(field, "Work only.");
    expect(within(dialog).getByText("10 / 4000")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Save policy" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.url).toBe("/api/keys/key-1/guardrail");
      expect(put?.init?.body).toBe(JSON.stringify({ policy: "Work only." }));
    });
  });

  test("an empty policy is not sent; removing one is its own action and sends null", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({ keys: [apiKey({ guardrailPolicy: "Work only." })] }),
      "PUT /api/keys/key-1/guardrail": () => apiKey(),
    });
    renderWithProviders(<KeysBoard />);

    // The row says the key is judged, without printing the text.
    expect(await screen.findByText("judged")).toBeTruthy();

    await user.click(await screen.findByRole("button", { name: "Edit usage policy for laptop" }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText("Policy") as HTMLTextAreaElement;
    expect(field.value).toBe("Work only.");

    await user.clear(field);
    await user.type(field, "   ");
    await user.click(within(dialog).getByRole("button", { name: "Save policy" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Remove policy");
    expect(stub.calls.some((call) => call.init?.method === "PUT")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Remove policy" }));
    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.init?.body).toBe(JSON.stringify({ policy: null }));
    });
  });

  test("an over-long policy is refused before it is sent", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({ "GET /api/keys": () => ({ keys: [apiKey()] }) });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: "Edit usage policy for laptop" }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText("Policy");
    await user.click(field);
    await user.paste("p".repeat(4001));
    expect(within(dialog).getByText("4001 / 4000")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Save policy" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("4000");
    expect(stub.calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  test("the dialog warns when no classifier is set, and only then", async () => {
    const user = userEvent.setup();
    stubKeys({
      "GET /api/keys": () => ({ keys: [apiKey()] }),
      "GET /api/settings": () => ({ settings, bodyLoggingAllowed: false }),
    });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: "Edit usage policy for laptop" }));
    const dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findByRole("status")).textContent).toContain(
      "No classifier model is set",
    );
  });
});

describe("confidential routing", () => {
  const configured = {
    ...settings,
    smartRouterEnabled: true,
    smartRouterClassifierModel: "local-judge",
    smartRouterLocalModel: "local-chat",
  };

  test("the switch saves at once, sending the new state whole", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({
      "GET /api/keys": () => ({ keys: [apiKey()] }),
      "PUT /api/keys/key-1/smart-routing": () => apiKey({ smartRouting: true }),
    });
    renderWithProviders(<KeysBoard />);

    const toggle = await screen.findByRole("switch", { name: "Confidential routing for laptop" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await user.click(toggle);

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.url).toBe("/api/keys/key-1/smart-routing");
      expect(put?.init?.body).toBe(JSON.stringify({ enabled: true }));
    });
  });

  test("a failed save is reported where the operator is looking", async () => {
    const user = userEvent.setup();
    stubKeys({
      "GET /api/keys": () => ({ keys: [apiKey()] }),
      "PUT /api/keys/key-1/smart-routing": () => ({
        status: 500,
        body: { error: { code: "INTERNAL", message: "store unavailable" } },
      }),
    });
    renderWithProviders(<KeysBoard />);

    await user.click(
      await screen.findByRole("switch", { name: "Confidential routing for laptop" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("laptop");
    expect(alert.textContent).toContain("store unavailable");
  });

  test("a revoked key offers no switch", async () => {
    stubKeys();
    renderWithProviders(<KeysBoard />);
    await screen.findByText("revoked");
    // Two live keys, one revoked.
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(screen.queryByRole("switch", { name: "Confidential routing for retired" })).toBeNull();
  });

  test("a flagged key wears a local-routed chip, and a plain key does not", async () => {
    stubKeys({
      "GET /api/keys": () => ({
        keys: [apiKey({ smartRouting: true }), apiKey({ id: "key-2", label: "ci" })],
      }),
      "GET /api/settings": () => ({ settings: configured, bodyLoggingAllowed: false }),
    });
    renderWithProviders(<KeysBoard />);

    const chip = await screen.findByText("local-routed");
    expect(screen.getAllByText("local-routed")).toHaveLength(1);
    // Healthy: the tooltip says what the chip means and carries no warning.
    await waitFor(() =>
      expect(chip.getAttribute("title")).not.toContain("Confidential routing is"),
    );
    expect(chip.getAttribute("title")).toContain("local");
  });

  const OFF =
    "Confidential routing is switched off in Settings; these keys' requests are not screened.";
  const misconfigured = (reason: string) =>
    `Confidential routing is misconfigured (${reason}); these keys' requests are refused.`;

  test("the chip's tooltip leads with the notice's sentence when the feature is off or misconfigured", async () => {
    const warned = async (
      loaded: typeof settings,
      models: { classifier: string; local: string } = { classifier: "ok", local: "ok" },
    ) => {
      stubKeys({
        "GET /api/keys": () => ({ keys: [apiKey({ smartRouting: true })] }),
        "GET /api/settings": () => ({
          settings: loaded,
          bodyLoggingAllowed: false,
          smartRouterModels: models,
        }),
      });
      const view = renderWithProviders(<KeysBoard />);
      const chip = await screen.findByText("local-routed");
      await waitFor(() =>
        expect(chip.getAttribute("title")).toStartWith("Confidential routing is"),
      );
      const title = chip.getAttribute("title") ?? "";
      view.unmount();
      return title;
    };

    expect(await warned({ ...configured, smartRouterEnabled: false })).toStartWith(OFF);
    expect(await warned({ ...configured, smartRouterLocalModel: null })).toStartWith(
      misconfigured("the local model is not set"),
    );
    expect(await warned({ ...configured, smartRouterClassifierModel: null })).toStartWith(
      misconfigured("the classifier model is not set"),
    );
    expect(await warned(configured, { classifier: "notLocal", local: "ok" })).toStartWith(
      misconfigured("the classifier model is not local-only"),
    );
  });

  test("a visible notice says whether flagged keys' requests are unscreened or refused", async () => {
    const notice = async (
      loaded: typeof settings,
      keys: ReturnType<typeof apiKey>[],
      models?: { classifier: string; local: string },
    ) => {
      stubKeys({
        "GET /api/keys": () => ({ keys }),
        "GET /api/settings": () => ({
          settings: loaded,
          bodyLoggingAllowed: false,
          ...(models === undefined ? {} : { smartRouterModels: models }),
        }),
      });
      const view = renderWithProviders(<KeysBoard />);
      await screen.findByText(keys[0]?.label ?? "");
      await waitFor(() => expect(screen.getAllByRole("button").length).toBeGreaterThan(0));
      // Let the settings read land before concluding anything is absent.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const found = screen.queryByRole("status")?.textContent ?? null;
      view.unmount();
      return found;
    };
    const flagged = [apiKey({ smartRouting: true })];

    expect(await notice({ ...configured, smartRouterEnabled: false }, flagged)).toBe(OFF);
    // An unset model refuses every flagged request; it never serves them unscreened.
    expect(await notice({ ...configured, smartRouterLocalModel: null }, flagged)).toBe(
      misconfigured("the local model is not set"),
    );
    expect(
      await notice(
        { ...configured, smartRouterClassifierModel: null, smartRouterLocalModel: null },
        flagged,
      ),
    ).toBe(misconfigured("the classifier model is not set and the local model is not set"));
    // A model that is set but cannot serve is reported by the gateway.
    expect(await notice(configured, flagged, { classifier: "unresolved", local: "ok" })).toBe(
      misconfigured("the classifier model does not resolve"),
    );
    expect(await notice(configured, flagged, { classifier: "ok", local: "notLocal" })).toBe(
      misconfigured("the local model is not local-only"),
    );
    // Switched off outranks a broken model: nothing is refused while off.
    expect(
      await notice({ ...configured, smartRouterEnabled: false }, flagged, {
        classifier: "unresolved",
        local: "notLocal",
      }),
    ).toBe(OFF);
    // Healthy, unflagged, or flagged only on a revoked key: nothing to say.
    expect(await notice(configured, flagged, { classifier: "ok", local: "ok" })).toBeNull();
    expect(await notice(configured, flagged)).toBeNull();
    expect(await notice({ ...configured, smartRouterEnabled: false }, [apiKey()])).toBeNull();
    expect(
      await notice({ ...configured, smartRouterEnabled: false }, [
        apiKey({ smartRouting: true, revokedAt: 1 }),
      ]),
    ).toBeNull();
  });
});
