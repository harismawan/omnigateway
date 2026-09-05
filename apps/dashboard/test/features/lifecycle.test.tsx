import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LifecycleControls } from "../../src/components/LifecycleControls.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { lifecycle } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

function stubLifecycle(overrides: Parameters<typeof createFetchStub>[0] = {}) {
  return createFetchStub({ "GET /api/lifecycle": () => lifecycle(), ...overrides });
}

describe("LifecycleControls", () => {
  test("the rail prints the gateway's version above its controls", async () => {
    stubLifecycle({ "GET /api/lifecycle": () => lifecycle({ version: "1.2.3" }) });
    renderWithProviders(<LifecycleControls />);

    expect(await screen.findByText("omnigateway v1.2.3")).toBeTruthy();
  });

  /**
   * The rail is 168px wide, so the visible labels are shortened. What a screen
   * reader announces and what the confirm dialog is titled must still name the
   * thing being stopped — "Shut down" alone does not say what goes down.
   */
  test("each control names the gateway however it is reached", async () => {
    stubLifecycle();
    renderWithProviders(<LifecycleControls pollMs={5} />);

    const restart = await screen.findByRole("button", { name: "Restart gateway" });
    const shutdown = screen.getByRole("button", { name: "Shut down gateway" });
    expect(restart.textContent).toContain("Restart");
    expect(shutdown.textContent).toContain("Shut down");
  });

  /**
   * A restart only restarts if something respawns the process. Offering the
   * control on an installation with no supervisor would stop the gateway and
   * present that as a restart.
   */
  test("restart is refused where nothing would respawn the gateway", async () => {
    stubLifecycle({
      "GET /api/lifecycle": () => lifecycle({ supervisor: "none", canRestart: false }),
    });
    renderWithProviders(<LifecycleControls pollMs={5} />);

    const restart = await screen.findByRole("button", { name: "Restart gateway" });
    expect(restart.hasAttribute("disabled")).toBe(true);
  });

  /**
   * The note is for a capability that is a hope rather than a fact. A container
   * cannot read its own restart policy, so the control is offered and the
   * uncertainty is stated beside it — the one shape that still earns a sentence.
   */
  test("a capability the gateway cannot verify states itself beside the control", async () => {
    stubLifecycle({
      "GET /api/lifecycle": () =>
        lifecycle({
          supervisor: "container",
          canRestart: true,
          note: "restart exits the container and relies on its restart policy, which cannot be read from inside it",
        }),
    });
    renderWithProviders(<LifecycleControls pollMs={5} />);

    const restart = await screen.findByRole("button", { name: "Restart gateway" });
    expect(restart.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/cannot be read from inside it/)).toBeTruthy();
  });

  /**
   * The rail has no room for the supervisor sentence, so it is the section's
   * title. Losing it entirely would leave the operator to guess what a restart
   * asks of this installation.
   */
  test("what is supervising the process stays one hover from the control", async () => {
    stubLifecycle();
    renderWithProviders(<LifecycleControls pollMs={5} />);

    const restart = await screen.findByRole("button", { name: "Restart gateway" });
    expect(restart.closest("[title]")?.getAttribute("title")).toContain("systemd");
  });

  /**
   * The two halves of a restart, and why a timer will not do.
   *
   * A gateway that is still answering has not restarted yet, and one that has
   * stopped answering is not ready to be reloaded into. Reloading on a fixed
   * delay lands in whichever of those two states the delay happened to hit.
   */
  test("restart waits for the gateway to go, and to come back, before reloading", async () => {
    const user = userEvent.setup();
    const reloads: string[] = [];
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: () => reloads.push("reload"),
    });

    let answering = true;
    const stub = stubLifecycle({
      "POST /api/lifecycle/restart": () => ({ ok: true }),
      "GET /health": () => {
        // A stopped gateway does not answer 503; the connection fails.
        if (!answering) throw new Error("connection refused");
        return { ok: true };
      },
    });
    renderWithProviders(<LifecycleControls pollMs={5} />);

    await user.click(await screen.findByRole("button", { name: "Restart gateway" }));
    await user.click(await screen.findByRole("button", { name: "Restart now" }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.url === "/api/lifecycle/restart")).toBe(true);
    });
    await waitFor(() => {
      expect(stub.calls.filter((call) => call.url === "/health").length).toBeGreaterThan(0);
    });
    // Still answering, so nothing has restarted and nothing is reloaded.
    expect(reloads).toHaveLength(0);

    expect((await screen.findByRole("status")).textContent).toContain("stop answering");

    answering = false;
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("has stopped answering");
    });
    expect(reloads).toHaveLength(0);

    answering = true;
    await waitFor(() => {
      expect(reloads).toHaveLength(1);
    });

    Reflect.deleteProperty(window.location, "reload");
  });

  /**
   * The other ending. Nothing is coming back, so there is nothing to poll for
   * and nothing to reload into — the rail says so and stops.
   */
  test("shutdown ends the rail's controls and waits for nothing", async () => {
    const user = userEvent.setup();
    const stub = stubLifecycle({ "POST /api/lifecycle/shutdown": () => ({ ok: true }) });
    renderWithProviders(<LifecycleControls pollMs={5} />);

    await user.click(await screen.findByRole("button", { name: "Shut down gateway" }));
    await user.click(await screen.findByRole("button", { name: "Shut down now" }));

    expect(await screen.findByText(/nothing here can start it/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart gateway" })).toBeNull();
    // Long enough for many polls at this interval, and none were made.
    expect(stub.calls.filter((call) => call.url === "/health")).toHaveLength(0);
  });

  test("shutting down a container says the dashboard goes with it", async () => {
    const user = userEvent.setup();
    stubLifecycle({
      "GET /api/lifecycle": () => lifecycle({ supervisor: "container", note: "restart exits" }),
    });
    renderWithProviders(<LifecycleControls pollMs={5} />);

    await user.click(await screen.findByRole("button", { name: "Shut down gateway" }));

    expect(await screen.findByText(/takes this dashboard with it/i)).toBeTruthy();
  });
});
