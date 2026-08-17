import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsBoard } from "../../src/features/settings/SettingsBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { settings } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

function stubSettings(overrides: Parameters<typeof createFetchStub>[0] = {}) {
  return createFetchStub({
    // `bodyLoggingAllowed` is a sibling of the settings, not a field inside
    // them: it is read from the environment at boot and is not editable here.
    "GET /api/settings": () => ({ settings, bodyLoggingAllowed: false }),
    ...overrides,
  });
}

/** The same route with the environment half of the capture contract in place. */
function stubPermitted(overrides: Parameters<typeof createFetchStub>[0] = {}) {
  return stubSettings({
    "GET /api/settings": () => ({ settings, bodyLoggingAllowed: true }),
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
    expect((screen.getByLabelText("Load") as HTMLInputElement).value).toBe("2");
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

  test("the request deadline can be disabled with zero", async () => {
    const user = userEvent.setup();
    const stub = stubSettings({ "PUT /api/settings": () => ({ ok: true }) });
    renderWithProviders(<SettingsBoard />);

    const field = (await screen.findByLabelText("Request deadline")) as HTMLInputElement;
    expect(field.min).toBe("0");
    expect(screen.getByText(/0 disables only OmniGateway's deadline/i)).toBeTruthy();

    await user.clear(field);
    await user.type(field, "0");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put).toBeTruthy();
      const body = JSON.parse(String(put?.init?.body)) as { requestDeadlineMs: number };
      expect(body.requestDeadlineMs).toBe(0);
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

  /**
   * The two-key contract, made legible.
   *
   * `OMNI_BODY_LOGGING_ALLOWED` is read at boot and cannot be set from here, so
   * on an installation without it the toggle would save happily and record
   * nothing. An operator flipping a switch that silently does nothing files a
   * bug; the screen has to say why instead.
   */
  test("a gateway that may not capture says so and will not let the toggle move", async () => {
    stubSettings();
    renderWithProviders(<SettingsBoard />);

    const toggle = await screen.findByRole("switch", {
      name: "Capture request and response bodies",
    });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/started without/)).toBeTruthy();
    expect(screen.getByText("OMNI_BODY_LOGGING_ALLOWED")).toBeTruthy();
  });

  test("a gateway that may capture offers the toggle and drops the warning", async () => {
    stubPermitted();
    renderWithProviders(<SettingsBoard />);

    const toggle = await screen.findByRole("switch", {
      name: "Capture request and response bodies",
    });
    expect(toggle.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText(/started without/)).toBeNull();
  });

  test("turning capture on sends both body logging settings as booleans", async () => {
    const user = userEvent.setup();
    const stub = stubPermitted({ "PUT /api/settings": () => ({ ok: true }) });
    renderWithProviders(<SettingsBoard />);

    await user.click(
      await screen.findByRole("switch", { name: "Capture request and response bodies" }),
    );
    await user.click(screen.getByRole("switch", { name: "Also keep raw stream frames" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      const body = JSON.parse(String(put?.init?.body)) as {
        bodyLoggingEnabled: unknown;
        bodyLoggingCaptureStreamChunks: unknown;
      };
      // Booleans, not the strings the draft holds and not numbers: the schema
      // rejects both, and `Number("false")` is `NaN`.
      expect(body.bodyLoggingEnabled).toBe(true);
      expect(body.bodyLoggingCaptureStreamChunks).toBe(true);
    });
  });

  /**
   * Stream frames are the most expensive thing capture can store, so they are
   * gated behind capture rather than implied by it.
   */
  test("raw stream frames cannot be armed while capture itself is off", async () => {
    stubPermitted();
    renderWithProviders(<SettingsBoard />);

    const chunks = await screen.findByRole("switch", { name: "Also keep raw stream frames" });
    expect(chunks.hasAttribute("disabled")).toBe(true);
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
