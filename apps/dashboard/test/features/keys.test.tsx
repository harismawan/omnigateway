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
          rateLimitPerMin: null,
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

  test("creating a key sends the label, allowlist, and limit", async () => {
    const user = userEvent.setup();
    const stub = stubKeys({ "POST /api/keys": () => minted });
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: /Create a key/ }));
    const dialog = await screen.findByRole("dialog");

    await user.type(within(dialog).getByLabelText("Label"), "ci-runner");
    await user.type(within(dialog).getByLabelText("Rate limit"), "60");
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));

    await waitFor(() => {
      const post = stub.calls.find((call) => call.init?.method === "POST");
      expect(post?.init?.body).toBe(
        JSON.stringify({
          label: "ci-runner",
          modelAllowlist: null,
          rateLimitPerMin: 60,
          bodyLoggingOptOut: false,
        }),
      );
    });
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

  test("a fractional rate limit is refused before it is sent", async () => {
    const user = userEvent.setup();
    const stub = stubKeys();
    renderWithProviders(<KeysBoard />);

    await user.click(await screen.findByRole("button", { name: /Create a key/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Rate limit"), "1.5");
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The rate limit must be a whole number of requests per minute, or blank for none.",
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
