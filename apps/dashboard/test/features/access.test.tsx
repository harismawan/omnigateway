import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccessPanel } from "../../src/features/settings/AccessPanel.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { renderWithProviders } from "../helpers/render.tsx";

function stubAccess(
  viewerConfigured: boolean,
  overrides: Parameters<typeof createFetchStub>[0] = {},
) {
  return createFetchStub({
    "GET /api/status": () => ({
      configured: true,
      authenticated: true,
      principal: { kind: "admin" },
      viewerConfigured,
    }),
    "PUT /api/settings/password": () => ({ ok: true }),
    "PUT /api/settings/viewer-password": () => ({ ok: true }),
    ...overrides,
  });
}

/** Both new-password boxes, filled with the same value. */
async function typeNewPassword(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.type(screen.getByLabelText("New password"), value);
  await user.type(screen.getByLabelText("Repeat new password"), value);
}

describe("admin password", () => {
  test("sends the current password with the new one", async () => {
    const user = userEvent.setup();
    const stub = stubAccess(false);
    renderWithProviders(<AccessPanel />);

    await user.type(screen.getByLabelText("Current password"), "hunter2hunter2");
    await typeNewPassword(user, "a-longer-new-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => {
      const call = stub.calls.find((entry) => entry.url === "/api/settings/password");
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.init?.body))).toEqual({
        current: "hunter2hunter2",
        password: "a-longer-new-password",
      });
    });
  });

  /**
   * The confirmation box exists to catch a typo before it becomes a lockout:
   * the password it sets is the one the operator will be asked for a second
   * later, with every session already ended.
   */
  test("a mistyped repeat is refused before anything is sent", async () => {
    const user = userEvent.setup();
    const stub = stubAccess(false);
    renderWithProviders(<AccessPanel />);

    await user.type(screen.getByLabelText("Current password"), "hunter2hunter2");
    await user.type(screen.getByLabelText("New password"), "a-longer-new-password");
    await user.type(screen.getByLabelText("Repeat new password"), "a-longer-new-passwerd");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/do not match/i);
    expect(stub.calls.some((entry) => entry.url === "/api/settings/password")).toBe(false);
  });

  test("a password too short to be accepted is refused before it is sent", async () => {
    const user = userEvent.setup();
    const stub = stubAccess(false);
    renderWithProviders(<AccessPanel />);

    await user.type(screen.getByLabelText("Current password"), "hunter2hunter2");
    await typeNewPassword(user, "short");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/at least 12/i);
    expect(stub.calls.some((entry) => entry.url === "/api/settings/password")).toBe(false);
  });

  test("a wrong current password is reported rather than swallowed", async () => {
    const user = userEvent.setup();
    stubAccess(false, {
      "PUT /api/settings/password": () => ({
        status: 401,
        body: { error: { code: "AUTH", message: "current password is incorrect" } },
      }),
    });
    renderWithProviders(<AccessPanel />);

    await user.type(screen.getByLabelText("Current password"), "wrong-password-x");
    await typeNewPassword(user, "a-longer-new-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /current password is incorrect/i,
    );
  });
});

describe("read-only password", () => {
  /**
   * "None is set" is a fact worth printing.
   *
   * There is no default read-only password, so a blank field would leave an
   * operator wondering whether the blank meant "unset" or "hidden".
   */
  test("says plainly when no read-only password exists", async () => {
    stubAccess(false);
    renderWithProviders(<AccessPanel />);

    expect(await screen.findByText(/None is set/)).toBeTruthy();
    expect(screen.getByText(/no default password/i)).toBeTruthy();
    // Nothing to withdraw, so no control offering to.
    expect(screen.queryByRole("button", { name: "Withdraw access" })).toBeNull();
  });

  test("setting one sends it and reports the grant", async () => {
    const user = userEvent.setup();
    const stub = stubAccess(false);
    renderWithProviders(<AccessPanel />);

    await user.type(screen.getByLabelText("Set read-only password"), "read-only-pass-1");
    await user.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() => {
      const call = stub.calls.find((entry) => entry.url === "/api/settings/viewer-password");
      expect(JSON.parse(String(call?.init?.body))).toEqual({ password: "read-only-pass-1" });
    });
    expect((await screen.findByRole("status")).textContent).toMatch(/granted/i);
  });

  test("an existing password is replaced rather than set, and can be withdrawn", async () => {
    const user = userEvent.setup();
    const stub = stubAccess(true);
    renderWithProviders(<AccessPanel />);

    expect(await screen.findByText(/One is set/)).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Withdraw access" }));

    await waitFor(() => {
      const call = stub.calls.find((entry) => entry.url === "/api/settings/viewer-password");
      // `null` is the withdrawal, and an omitted field would be a malformed
      // request: "leave it alone" and "remove it" must not share a spelling.
      expect(JSON.parse(String(call?.init?.body))).toEqual({ password: null });
    });
    expect((await screen.findByRole("status")).textContent).toMatch(/withdrawn/i);
  });

  test("a short read-only password is refused before it is sent", async () => {
    const user = userEvent.setup();
    const stub = stubAccess(false);
    renderWithProviders(<AccessPanel />);

    await user.type(screen.getByLabelText("Set read-only password"), "short");
    await user.click(screen.getByRole("button", { name: "Set" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/at least 12/i);
    expect(stub.calls.some((entry) => entry.url === "/api/settings/viewer-password")).toBe(false);
  });
});
