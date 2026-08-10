import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsBoard } from "../../src/features/settings/SettingsBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { settings } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

function stubSettings(overrides: Parameters<typeof createFetchStub>[0] = {}) {
  return createFetchStub({
    "GET /api/settings": () => ({ settings }),
    ...overrides,
  });
}

describe("SettingsBoard", () => {
  test("loads the current weights and limits into the form", async () => {
    stubSettings();
    renderWithProviders(<SettingsBoard />);

    await waitFor(() => {
      expect((screen.getByLabelText("Tier") as HTMLInputElement).value).toBe("10");
    });
    expect((screen.getByLabelText("Request deadline") as HTMLInputElement).value).toBe("120000");
    expect((screen.getByLabelText("Recency") as HTMLInputElement).value).toBe("0.5");
  });

  test("toggles deterministic lossy RTK compression and sends the setting", async () => {
    const user = userEvent.setup();
    const stub = stubSettings({ "PUT /api/settings": () => ({ ok: true }) });
    renderWithProviders(<SettingsBoard />);

    const toggle = await screen.findByRole("switch", { name: "Enable RTK compression" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/unknown-origin results may be compressed/i)).toBeTruthy();
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      const body = JSON.parse(String(put?.init?.body)) as { rtkEnabled: boolean };
      expect(body.rtkEnabled).toBe(true);
    });
  });

  test("the quota poll interval is editable and can be switched off", async () => {
    const user = userEvent.setup();
    const stub = stubSettings({ "PUT /api/settings": () => ({ ok: true }) });
    renderWithProviders(<SettingsBoard />);

    const field = (await screen.findByLabelText("Quota poll interval")) as HTMLInputElement;
    expect(field.value).toBe("300000");

    await user.clear(field);
    await user.type(field, "0");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put).toBeTruthy();
      const body = JSON.parse(String(put?.init?.body)) as { quotaPollIntervalMs: number };
      expect(body.quotaPollIntervalMs).toBe(0);
    });
  });

  test("saving sends numbers, not the strings the fields hold", async () => {
    const user = userEvent.setup();
    const stub = stubSettings({ "PUT /api/settings": () => ({ ok: true }) });
    renderWithProviders(<SettingsBoard />);

    const cost = await screen.findByLabelText("Cost");
    await user.clear(cost);
    await user.type(cost, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.url).toBe("/api/settings");
      expect(JSON.parse(String(put?.init?.body))).toEqual({
        ...settings,
        weights: { ...settings.weights, cost: 4 },
      });
    });
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  test("a limit below its floor is named and refused", async () => {
    const user = userEvent.setup();
    const stub = stubSettings();
    renderWithProviders(<SettingsBoard />);

    const attempts = await screen.findByLabelText("Attempts per request");
    await user.clear(attempts);
    await user.type(attempts, "0");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Attempts per request must be a whole number of 1 or more.",
    );
    expect(stub.calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  test("the control API's attempt ceiling is enforced before the request", async () => {
    const user = userEvent.setup();
    const stub = stubSettings();
    renderWithProviders(<SettingsBoard />);

    const attempts = await screen.findByLabelText("Attempts per request");
    await user.clear(attempts);
    await user.type(attempts, "11");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Attempts per request cannot exceed 10.",
    );
    expect(stub.calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  test("a non-numeric weight is refused", async () => {
    const user = userEvent.setup();
    stubSettings();
    renderWithProviders(<SettingsBoard />);

    const health = await screen.findByLabelText("Health");
    await user.clear(health);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Health must be a number.");
  });

  test("the process-local nature of rate limits is stated, not implied", async () => {
    stubSettings();
    renderWithProviders(<SettingsBoard />);

    expect(await screen.findByText(/reset when it restarts/i)).toBeTruthy();
  });

  test("a failed read offers a retry", async () => {
    stubSettings({
      "GET /api/settings": () => ({
        status: 500,
        body: { error: { code: "INTERNAL", message: "internal error" } },
      }),
    });
    renderWithProviders(<SettingsBoard />);

    expect(await screen.findByText("internal error")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
