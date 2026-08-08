import { afterEach, describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../../src/api/client.ts";
import { CopyValue } from "../../src/components/CopyValue.tsx";
import { Lamp } from "../../src/ui/Lamp.tsx";
import { Meter } from "../../src/ui/Meter.tsx";
import { Module } from "../../src/ui/Panel.tsx";
import { Readout } from "../../src/ui/Readout.tsx";
import { Sparkline } from "../../src/ui/Sparkline.tsx";
import { Empty, Failure } from "../../src/ui/States.tsx";
import { renderWithProviders } from "../helpers/render.tsx";

describe("Lamp", () => {
  test("carries its state in the glyph as well as the colour", () => {
    renderWithProviders(
      <>
        <Lamp state="ok" label="healthy" />
        <Lamp state="warn" label="probing" />
        <Lamp state="down" label="breaker open" />
        <Lamp state="idle" label="disabled" />
      </>,
    );

    expect(screen.getByRole("img", { name: "healthy" }).textContent).toBe("●");
    expect(screen.getByRole("img", { name: "probing" }).textContent).toBe("◐");
    expect(screen.getByRole("img", { name: "breaker open" }).textContent).toBe("○");
    expect(screen.getByRole("img", { name: "disabled" }).textContent).toBe("·");
  });
});

describe("Meter", () => {
  test("reports its reading to assistive tech", () => {
    renderWithProviders(<Meter fraction={0.62} label="5h window, 62% used" />);
    const meter = screen.getByRole("meter", { name: "5h window, 62% used" });
    expect(meter.getAttribute("aria-valuenow")).toBe("62");
  });

  test("clamps a reading that runs past its limit", () => {
    renderWithProviders(<Meter fraction={1.8} label="over" />);
    expect(screen.getByRole("meter", { name: "over" }).getAttribute("aria-valuenow")).toBe("100");
  });
});

describe("Sparkline", () => {
  test("is announced by its label, not by its path", () => {
    renderWithProviders(<Sparkline values={[1, 4, 2]} label="12 requests" />);
    expect(screen.getByRole("img", { name: "12 requests" })).toBeTruthy();
  });

  test("draws nothing rather than crashing on an empty series", () => {
    const { container } = renderWithProviders(<Sparkline values={[]} label="no traffic" />);
    expect(container.querySelector("svg")).toBeTruthy();
  });

  test("an explicit scale keeps a small series small", () => {
    const { container } = renderWithProviders(
      <Sparkline values={[1]} scaleTo={100} height={20} label="one failure in a hundred" />,
    );
    const path = container.querySelectorAll("path");
    // The trace sits near the baseline (y ≈ height) rather than at the top.
    const trace = path[path.length - 1]?.getAttribute("d") ?? "";
    expect(trace).toContain("19.80");
  });
});

describe("Readout", () => {
  test("shows the number, its unit, and its legend", () => {
    renderWithProviders(<Readout legend="Error rate" value="9.4%" unit="15 failed" />);
    expect(screen.getByText("Error rate")).toBeTruthy();
    expect(screen.getByText("9.4%")).toBeTruthy();
    expect(screen.getByText("15 failed")).toBeTruthy();
  });
});

describe("Module", () => {
  test("labels the panel and hosts its actions", () => {
    renderWithProviders(
      <Module legend="Accounts" meta="4 connected" actions={<button type="button">Manage</button>}>
        <p>body</p>
      </Module>,
    );
    expect(screen.getByText("Accounts")).toBeTruthy();
    expect(screen.getByText("4 connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage" })).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
  });
});

describe("States", () => {
  test("an empty screen invites an action", () => {
    renderWithProviders(<Empty legend="No keys" message="Create a key and give it to a client." />);
    expect(screen.getByText("Create a key and give it to a client.")).toBeTruthy();
  });

  test("a failure states the gateway's own message", () => {
    renderWithProviders(<Failure error={new ApiError(503, "OVERLOADED", "upstream is busy")} />);
    expect(screen.getByText("upstream is busy")).toBeTruthy();
  });

  test("an unknown throw still says something useful", () => {
    renderWithProviders(<Failure error={"a string"} />);
    expect(screen.getByText("The gateway did not answer.")).toBeTruthy();
  });
});

describe("CopyValue", () => {
  /** Replaces navigator.clipboard after userEvent.setup(), which installs its own. */
  function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: writeText === undefined ? undefined : { writeText },
    });
  }

  /** Stands in for document.execCommand, which happy-dom does not implement. */
  function stubExecCommand(result: boolean | (() => boolean)) {
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: typeof result === "function" ? result : () => result,
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(document, "execCommand");
  });

  test("copies on demand and confirms it", async () => {
    const user = userEvent.setup();
    const copied: string[] = [];
    stubClipboard((text) => {
      copied.push(text);
      return Promise.resolve();
    });

    renderWithProviders(<CopyValue value="omni_sk_secret" label="Copy API key" />);

    await user.click(screen.getByRole("button", { name: "Copy API key" }));
    expect(copied).toEqual(["omni_sk_secret"]);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("falls back to the legacy path when the clipboard API is absent", async () => {
    // Exactly what a gateway served over plain HTTP looks like: no secure
    // context, so navigator.clipboard does not exist at all.
    const user = userEvent.setup();
    stubClipboard(undefined);
    let execCommandCalls = 0;
    stubExecCommand(() => {
      execCommandCalls += 1;
      return true;
    });

    renderWithProviders(<CopyValue value="omni_sk_secret" label="Copy API key" />);
    await user.click(screen.getByRole("button", { name: "Copy API key" }));

    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(execCommandCalls).toBe(1);
  });

  test("falls back when the clipboard API exists but rejects", async () => {
    const user = userEvent.setup();
    stubClipboard(() => Promise.reject(new Error("denied by permissions policy")));
    stubExecCommand(true);

    renderWithProviders(<CopyValue value="omni_sk_secret" label="Copy API key" />);
    await user.click(screen.getByRole("button", { name: "Copy API key" }));

    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  test("says so when nothing reached the clipboard", async () => {
    const user = userEvent.setup();
    stubClipboard(undefined);
    stubExecCommand(false);

    renderWithProviders(<CopyValue value="omni_sk_secret" label="Copy API key" />);
    await user.click(screen.getByRole("button", { name: "Copy API key" }));

    // Never claims success: the key is shown once, so a silent failure would
    // cost the operator the key.
    expect((await screen.findByRole("status")).textContent).toMatch(/would not copy it/);
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy API key" })).toBeTruthy();
  });

  test("an execCommand that throws is treated as a failure, not a crash", async () => {
    const user = userEvent.setup();
    stubClipboard(undefined);
    stubExecCommand(() => {
      throw new Error("not allowed");
    });

    renderWithProviders(<CopyValue value="omni_sk_secret" label="Copy API key" />);
    await user.click(screen.getByRole("button", { name: "Copy API key" }));

    expect((await screen.findByRole("status")).textContent).toMatch(/would not copy it/);
  });

  test("the value stays on screen whatever happens", async () => {
    const user = userEvent.setup();
    stubClipboard(undefined);
    stubExecCommand(false);

    renderWithProviders(<CopyValue value="omni_sk_secret" label="Copy API key" />);
    await user.click(screen.getByRole("button", { name: "Copy API key" }));

    expect(screen.getByText("omni_sk_secret")).toBeTruthy();
  });
});
