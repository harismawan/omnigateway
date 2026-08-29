import { beforeEach, expect, test } from "bun:test";
import type { LiveConnection } from "@omnigateway/dashboard-sdk";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChassisBar } from "../../src/components/ChassisBar.tsx";
import { LiveProvider } from "../../src/session/live.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { renderWithRouter } from "../helpers/render.tsx";
import { createStubTimer, installSocketStub } from "../helpers/socketStub.ts";

beforeEach(() => {
  createFetchStub({
    "GET /api/logs": () => ({ logs: [] }),
    "GET /api/plugins": () => ({ plugins: [] }),
  });
});

const connection = (status: LiveConnection["status"]): LiveConnection => ({
  status,
  pushed: () => status === "push",
});

/**
 * The four states, named by what an operator is told rather than by what is
 * drawn.
 *
 * The accessible name is asserted separately from the text on purpose: the
 * visual label carries a middle dot, and pinning that into every assertion
 * would make rewording the chip a test edit. The two are allowed to differ, so
 * both are stated.
 */
const STATES = [
  { status: "push", name: "live, pushing", text: "LIVE·PUSH" },
  { status: "poll", name: "live, polling", text: "LIVE·POLL" },
  { status: "offline", name: "offline", text: "OFFLINE" },
] as const;

for (const state of STATES) {
  test(`the refresh switch reads "${state.name}" on a ${state.status} connection`, async () => {
    renderWithRouter(
      <LiveProvider connection={connection(state.status)}>
        <ChassisBar />
      </LiveProvider>,
    );

    const button = await screen.findByRole("button", { name: state.name });
    expect(button.textContent).toContain(state.text);
    // Refreshing, whichever way it arrives. `offline` is the one that is not,
    // and it is reported by the name rather than by un-pressing the switch.
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
}

test("pausing reads paused whatever the transport is doing", async () => {
  // The switch outranks the transport, exactly as `cadence` does: an operator
  // who switched refreshing off is not asking how it would have arrived.
  const user = userEvent.setup();
  renderWithRouter(
    <LiveProvider connection={connection("push")}>
      <ChassisBar />
    </LiveProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "live, pushing" }));

  const button = screen.getByRole("button", { name: "paused" });
  expect(button.textContent).toContain("PAUSED");
  expect(button.textContent).not.toContain("LIVE");
});

test("the separator between the two halves is hidden from assistive tech", async () => {
  // It is punctuation, and it is the reason the accessible name is stated
  // separately at all: read aloud it is noise, and asserted against it is a
  // rendering detail welded into every test that names this button.
  renderWithRouter(
    <LiveProvider connection={connection("push")}>
      <ChassisBar />
    </LiveProvider>,
  );

  const button = await screen.findByRole("button", { name: "live, pushing" });
  expect(button.querySelector('span[aria-hidden="true"]')?.textContent).toBe("·");
});

test("aria-pressed tracks the LIVE switch and not the connection", async () => {
  // Pressed answers "am I refreshing", which is the only thing this button
  // changes. A socket that dropped is not something the operator toggled and
  // must not be reported as though it were.
  const user = userEvent.setup();
  renderWithRouter(
    <LiveProvider connection={connection("poll")}>
      <ChassisBar />
    </LiveProvider>,
  );

  expect(
    (await screen.findByRole("button", { name: "live, polling" })).getAttribute("aria-pressed"),
  ).toBe("true");

  await user.click(screen.getByRole("button", { name: "live, polling" }));
  expect(screen.getByRole("button", { name: "paused" }).getAttribute("aria-pressed")).toBe("false");

  await user.click(screen.getByRole("button", { name: "paused" }));
  expect(screen.getByRole("button", { name: "live, polling" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

test("the switch no longer describes itself as polling when it is not", async () => {
  // The old title said "Pause polling" in both states. With a socket up that is
  // simply false, and a tooltip that lies about the transport is worse than one
  // that says nothing.
  renderWithRouter(
    <LiveProvider connection={connection("push")}>
      <ChassisBar />
    </LiveProvider>,
  );

  const title = (await screen.findByRole("button", { name: "live, pushing" })).getAttribute(
    "title",
  );
  expect(title).not.toContain("Pause polling");
  expect(title).toContain("push");
});

test("the mark lamp keeps answering its own question while the switch is offline", async () => {
  // Two indicators that always agree hide the case worth seeing. `offline` here
  // is about the refresh transport; the lamp at the far left is reading the log
  // fetch, and with that fetch succeeding it must not start saying "unreachable".
  renderWithRouter(
    <LiveProvider connection={connection("offline")}>
      <ChassisBar />
    </LiveProvider>,
  );

  await screen.findByRole("button", { name: "offline" });
  expect(screen.queryByRole("img", { name: "request log unreadable" })).toBeNull();
});

test("a live socket reaches the chassis through the providers the app mounts", async () => {
  // The nesting assertion. `StreamProvider` has to sit above the LIVE switch,
  // because the switch reads transport state; the other way round the switch
  // finds no socket, takes its polling default, and this reads "live, polling"
  // while every other test in the suite stays green. That exact failure has
  // happened in this codebase before — see the context-identity test in
  // `test/session/live.test.tsx`.
  const stub = installSocketStub();
  const timer = createStubTimer();

  renderWithRouter(<ChassisBar />, { stream: { enabled: true, timer: timer.schedule } });
  act(() => {
    stub.last().open();
    stub.last().ackAll();
  });

  expect(await screen.findByRole("button", { name: "live, pushing" })).toBeDefined();
});
