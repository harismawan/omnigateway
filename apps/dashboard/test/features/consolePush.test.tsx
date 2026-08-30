import { expect, test } from "bun:test";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONSOLE_CADENCE_MS } from "../../src/api/queries.ts";
import { ConsoleBoard } from "../../src/features/console/ConsoleBoard.tsx";
import { CONSOLE_TOPIC } from "../../src/session/invalidation.ts";
import { createFetchStub, type FetchStub } from "../helpers/fetchStub.ts";
import { renderWithProviders } from "../helpers/render.tsx";
import { createStubTimer, installSocketStub, type StubSocket } from "../helpers/socketStub.ts";

/**
 * `stream:console` is the one topic that pushes a payload rather than an
 * invalidation, so these are the tests for the class as a whole: the cursor a
 * reconnect resumes from, the `gap` that must never be stitched over, and the
 * two ways the panel is left on REST — a refused topic, and no socket at all.
 *
 * Every test here drives the socket by hand. The stub's constructor is inert,
 * so "connected" is a call rather than a wait, and a frame arriving is `emit`
 * rather than a timer nobody can pin down.
 */

const BOOT = {
  raw: "2026-08-09T04:12:03.114Z INFO  omnigateway listening  port=9000",
  at: 1_786_000_323_114,
  level: "info",
  msg: "omnigateway listening",
};

const REFRESHED = {
  raw: "2026-08-09T04:12:09.000Z INFO  credential refreshed  provider=anthropic",
  at: 1_786_000_329_000,
  level: "info",
  msg: "credential refreshed",
};

const QUOTA_FAILED = {
  raw: "2026-08-09T04:12:11.000Z ERROR quota poll failed  reason=boom",
  at: 1_786_000_331_000,
  level: "error",
  msg: "quota poll failed",
};

const ROUTED = {
  raw: "2026-08-09T04:12:12.000Z DEBUG router considered  targets=3",
  at: 1_786_000_332_000,
  level: "debug",
  msg: "router considered",
};

const file = (lines: unknown[]) => ({ source: "file", path: "/var/log/omni.log", lines });

const consoleCalls = (stub: FetchStub): number =>
  stub.calls.filter((call) => call.url.startsWith("/api/console")).length;

/** Opens the socket and answers every outstanding subscribe, as a healthy gateway does. */
function connect(socket: StubSocket): void {
  act(() => {
    socket.open();
    socket.ackAll();
  });
}

function push(socket: StubSocket, seq: number, lines: unknown[]): void {
  act(() => {
    socket.emit({ type: "event", topic: CONSOLE_TOPIC, seq, payload: { lines } });
  });
}

test("a pushed console frame appends its lines without refetching the log", async () => {
  const stub = createFetchStub({ "GET /api/console": () => file([BOOT]) });
  const socket = installSocketStub();
  const timer = createStubTimer();

  renderWithProviders(<ConsoleBoard />, { stream: { enabled: true, timer: timer.schedule } });
  expect(await screen.findByText(/omnigateway listening/)).toBeTruthy();

  connect(socket.last());
  const before = consoleCalls(stub);
  push(socket.last(), 1, [REFRESHED]);

  expect(await screen.findByText(/credential refreshed/)).toBeTruthy();
  // The point of the payload class. A frame that ended in an invalidation would
  // be a whole-window read per delta, which is the cost the ring exists to
  // avoid — and the REST read is still on screen underneath it.
  expect(consoleCalls(stub)).toBe(before);
  expect(screen.getByText(/omnigateway listening/)).toBeTruthy();
});

test("a reconnect resubscribes from the highest seq seen, not from zero", async () => {
  const stub = createFetchStub({ "GET /api/console": () => file([BOOT]) });
  const socket = installSocketStub();
  const timer = createStubTimer();

  renderWithProviders(<ConsoleBoard />, { stream: { enabled: true, timer: timer.schedule } });
  await screen.findByText(/omnigateway listening/);

  connect(socket.last());
  push(socket.last(), 9, [REFRESHED]);
  await screen.findByText(/credential refreshed/);

  act(() => {
    socket.last().close(1006, "dropped");
  });
  act(() => {
    timer.fire();
  });
  act(() => {
    socket.last().open();
  });

  // Read off the wire rather than off any internal state: `sinceSeq` is what
  // the ring measures a gap against, so a resubscribe from 0 would ask for a
  // replay of everything and be answered `gap` on any log older than the ring.
  const resumed = socket
    .last()
    .frames()
    .find((frame) => frame.topic === CONSOLE_TOPIC);
  expect(resumed).toEqual({ type: "subscribe", topic: CONSOLE_TOPIC, sinceSeq: 9 });
  expect(consoleCalls(stub)).toBeGreaterThan(0);
});

test("a gap frame refetches the whole window instead of stitching onto a hole", async () => {
  // The highest-value test in this file. `gap` is the ring admitting it can no
  // longer supply what this client missed, and the failure it exists to prevent
  // is precisely a console that keeps appending across the hole and looks
  // perfectly healthy doing it.
  let body: unknown = file([BOOT]);
  const stub = createFetchStub({ "GET /api/console": () => body as Record<string, unknown> });
  const socket = installSocketStub();
  const timer = createStubTimer();

  renderWithProviders(<ConsoleBoard />, { stream: { enabled: true, timer: timer.schedule } });
  await screen.findByText(/omnigateway listening/);

  connect(socket.last());
  push(socket.last(), 1, [REFRESHED]);
  await screen.findByText(/credential refreshed/);
  const before = consoleCalls(stub);

  // The log was rotated under the watcher: the window the gateway can serve no
  // longer contains what this client was shown.
  body = file([QUOTA_FAILED]);
  act(() => {
    socket.last().emit({ type: "gap", topic: CONSOLE_TOPIC, seq: 12 });
  });

  expect(await screen.findByText(/quota poll failed/)).toBeTruthy();
  await waitFor(() => {
    expect(consoleCalls(stub)).toBe(before + 1);
  });
  // Neither the frame that was appended before the gap nor the line the old
  // window carried survives it. Both are outside the window the gateway just
  // served, and keeping either is the stitch.
  expect(screen.queryByText(/credential refreshed/)).toBeNull();
  expect(screen.queryByText(/omnigateway listening/)).toBeNull();
});

test("a transport status arm is ignored, not read as a hole", async () => {
  // `open`, `refused` and `closed` were added to `TopicMessage` for plugin
  // channels, which can be refused; they are delivered by topic, so this board
  // sees them too. Its `gap` arm treats anything that is not a readable frame
  // as a hole and drops the accumulated tail — so without an explicit ignore,
  // an `ack` for `stream:console` would clear the terminal on every reconnect.
  //
  // Reachable today only because the ack arrives before anything has
  // accumulated, which is luck rather than design: this drives the arm after a
  // frame has landed, which is the arrangement the next status arm would hit.
  const stub = createFetchStub({ "GET /api/console": () => file([BOOT]) });
  const socket = installSocketStub();
  const timer = createStubTimer();

  renderWithProviders(<ConsoleBoard />, { stream: { enabled: true, timer: timer.schedule } });
  await screen.findByText(/omnigateway listening/);

  connect(socket.last());
  push(socket.last(), 1, [REFRESHED]);
  await screen.findByText(/credential refreshed/);
  const before = consoleCalls(stub);

  // A second ack on the same topic: what a resubscribe answers with.
  act(() => {
    socket.last().emit({ type: "ack", topic: CONSOLE_TOPIC });
  });

  // The pushed line is still there, and nothing was refetched to put it back.
  expect(screen.getByText(/credential refreshed/)).toBeTruthy();
  expect(consoleCalls(stub)).toBe(before);
});

test(
  "an error frame leaves the panel polling over REST",
  async () => {
    // The installation whose log capture is `none`: there is no source behind
    // `stream:console`, the subscribe is answered `error`, and this panel must
    // go back to its interval rather than sit waiting for a frame that is never
    // coming. Asserted by letting the interval actually elapse — the number a
    // component would have handed react-query is checked in
    // `test/session/stream.test.tsx`, and being plausible is not the same as a
    // second request arriving.
    const stub = createFetchStub({ "GET /api/console": () => ({ source: "none", lines: [] }) });
    const socket = installSocketStub();
    const timer = createStubTimer();

    renderWithProviders(<ConsoleBoard />, { stream: { enabled: true, timer: timer.schedule } });
    expect(await screen.findByText("Nothing is capturing this gateway")).toBeTruthy();

    act(() => {
      const live = socket.last();
      live.open();
      for (const frame of live.frames()) {
        if (frame.type !== "subscribe" || frame.topic === undefined) continue;
        live.emit(
          frame.topic === CONSOLE_TOPIC
            ? { type: "error", topic: frame.topic }
            : { type: "ack", topic: frame.topic },
        );
      }
    });

    await waitFor(() => expect(consoleCalls(stub)).toBeGreaterThanOrEqual(2), {
      timeout: CONSOLE_CADENCE_MS * 2,
    });
  },
  CONSOLE_CADENCE_MS * 3,
);

test("a pushed line the level filter excludes is not shown", async () => {
  // The property `parseConsoleLines` exists to hold, checked from the client
  // end: a line must not become visible merely because it arrived over the
  // socket rather than over a reload. The gateway publishes every level, so
  // this filter is the panel's own and has to match the one the REST read asked
  // the gateway for.
  const stub = createFetchStub({ "GET /api/console": () => file([QUOTA_FAILED]) });
  const socket = installSocketStub();
  const timer = createStubTimer();

  renderWithProviders(<ConsoleBoard />, { stream: { enabled: true, timer: timer.schedule } });
  await screen.findByText(/quota poll failed/);

  await userEvent.selectOptions(screen.getByLabelText("Which levels to show"), "error");
  await waitFor(() => {
    expect(stub.calls.some((call) => call.url.includes("level=error"))).toBe(true);
  });

  connect(socket.last());
  push(socket.last(), 1, [ROUTED, QUOTA_FAILED]);

  // The error in the same frame is what makes this a filter rather than a
  // dropped frame: without it, an implementation that ignored pushed lines
  // entirely would pass.
  await waitFor(() => {
    expect(screen.getAllByText(/quota poll failed/).length).toBe(2);
  });
  expect(screen.queryByText(/router considered/)).toBeNull();
});

test("the accumulated lines stay bounded at the page size", async () => {
  // A tab left open on a busy log is the whole reason for the cap: appending
  // forever is an unbounded array, and the panel's own page size is the number
  // it already promises to show.
  const stub = createFetchStub({ "GET /api/console": () => file([BOOT]) });
  const socket = installSocketStub();
  const timer = createStubTimer();

  renderWithProviders(<ConsoleBoard />, { stream: { enabled: true, timer: timer.schedule } });
  await screen.findByText(/omnigateway listening/);

  await userEvent.selectOptions(screen.getByLabelText("How many lines to fetch"), "100");
  await waitFor(() => {
    expect(stub.calls.some((call) => call.url.includes("lines=100"))).toBe(true);
  });

  connect(socket.last());
  const flood = Array.from({ length: 150 }, (_, index) => ({
    ...REFRESHED,
    raw: `pushed line ${index + 1}`,
  }));
  push(socket.last(), 1, flood);

  expect(await screen.findByText("pushed line 150")).toBeTruthy();
  expect(screen.queryByText("pushed line 1")).toBeNull();
  expect(screen.queryByText("pushed line 50")).toBeNull();
  // The header counts what is on screen, so the cap is visible rather than
  // internal: 100 rows, not 151.
  expect(screen.getByText(/^100 lines of what this process is doing/)).toBeTruthy();
});
