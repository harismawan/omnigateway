import { expect, test } from "bun:test";
import { act, screen, waitFor } from "@testing-library/react";
import { LOG_CADENCE_MS, queryKeys } from "../../src/api/queries.ts";
import { LogsBoard } from "../../src/features/logs/LogsBoard.tsx";
import { useLive } from "../../src/session/live.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { makeQueryClient, renderWithProviders } from "../helpers/render.tsx";
import { createStubTimer, installSocketStub, type StubFrame } from "../helpers/socketStub.ts";

/**
 * What every board reads, rendered as text.
 *
 * The values under test are the ones that reach `refetchInterval`, so they are
 * asserted as the strings a component would have handed to react-query rather
 * than as hook internals. Two topics side by side because the interesting cases
 * are the ones where they disagree.
 */
function Probe() {
  const { cadence, connection } = useLive();
  return (
    <div>
      <span data-testid="status">{connection.status}</span>
      <span data-testid="logs">{String(cadence(2_000, "res:logs"))}</span>
      <span data-testid="console">{String(cadence(5_000, "stream:console"))}</span>
      <span data-testid="bare">{String(cadence(2_000))}</span>
    </div>
  );
}

const read = (id: string): string => screen.getByTestId(id).textContent ?? "";

const topicsSent = (frames: StubFrame[]): (string | undefined)[] =>
  frames.filter((frame) => frame.type === "subscribe").map((frame) => frame.topic);

test("an acked topic stops polling and the tab reports push", () => {
  const stub = installSocketStub();
  const timer = createStubTimer();

  renderWithProviders(<Probe />, { stream: { enabled: true, timer: timer.schedule } });

  // The constructor is inert, so this is the whole connected state in one call
  // rather than a wait for one.
  act(() => {
    stub.last().open();
  });
  expect(topicsSent(stub.last().frames())).toContain("res:logs");
  // Subscribed is not yet pushed: the server has not said it holds the topic.
  expect(read("logs")).toBe("2000");

  act(() => {
    stub.last().ackAll();
  });

  expect(read("status")).toBe("push");
  expect(read("logs")).toBe("false");
  expect(read("console")).toBe("false");
  // The back-compat arm. A panel that predates the topic argument keeps its
  // interval however healthy the socket is.
  expect(read("bare")).toBe("2000");
});

test("a topic the gateway refuses keeps polling while the rest are pushed", () => {
  // The installation whose log capture is `none`: `stream:console` has no source
  // behind it and is answered `error`, and that panel must not go quiet.
  const stub = installSocketStub();
  const timer = createStubTimer();

  renderWithProviders(<Probe />, { stream: { enabled: true, timer: timer.schedule } });
  act(() => {
    stub.last().open();
    stub.last().ackAll();
  });
  act(() => {
    stub.last().emit({ type: "error", topic: "stream:console" });
  });

  expect(read("console")).toBe("5000");
  expect(read("logs")).toBe("false");
});

test("a res:logs frame invalidates the log listing and not a captured body", () => {
  const client = makeQueryClient();
  client.setQueryData(queryKeys.logs(100), []);
  client.setQueryData(queryKeys.requestBody("req_1"), { requestId: "req_1" });
  const stub = installSocketStub();
  const timer = createStubTimer();

  renderWithProviders(<Probe />, { client, stream: { enabled: true, timer: timer.schedule } });
  act(() => {
    stub.last().open();
    stub.last().ackAll();
  });
  act(() => {
    stub.last().emit({ type: "event", topic: "res:logs" });
  });

  expect(client.getQueryState(queryKeys.logs(100))?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.requestBody("req_1"))?.isInvalidated).toBe(false);
});

test("a reconnect invalidates before it resubscribes, and resumes from the last seq", () => {
  // Both halves matter and the order is the interesting one. Resubscribing
  // first leaves a window where fresh frames are landing on stale data and the
  // console looks perfectly healthy — so this asserts, for every frame the new
  // socket writes, that the cache had already been marked stale when it went
  // out. Reversed, the first frame records `false` here.
  const client = makeQueryClient();
  client.setQueryData(queryKeys.logs(100), []);
  const stub = installSocketStub();
  const timer = createStubTimer();

  renderWithProviders(<Probe />, { client, stream: { enabled: true, timer: timer.schedule } });
  act(() => {
    stub.last().open();
    stub.last().ackAll();
  });
  act(() => {
    stub.last().emit({ type: "event", topic: "stream:console", seq: 7, payload: { lines: [] } });
  });
  // The frame above refetched nothing — there is no console query in this cache
  // — so the log listing is the one that records the reconnect's invalidation.
  client.setQueryData(queryKeys.logs(100), []);
  expect(client.getQueryState(queryKeys.logs(100))?.isInvalidated).toBe(false);

  const staleWhenSent: boolean[] = [];
  stub.onSend = () => {
    staleWhenSent.push(client.getQueryState(queryKeys.logs(100))?.isInvalidated === true);
  };

  act(() => {
    stub.last().close(1006, "dropped");
  });
  expect(timer.pending).toBe(1);
  act(() => {
    timer.fire();
  });
  expect(stub.sockets.length).toBe(2);
  act(() => {
    stub.last().open();
  });

  expect(staleWhenSent.length).toBeGreaterThan(0);
  expect(staleWhenSent.every(Boolean)).toBe(true);

  const resumed = stub
    .last()
    .frames()
    .find((frame) => frame.topic === "stream:console");
  expect(resumed).toEqual({ type: "subscribe", topic: "stream:console", sinceSeq: 7 });
});

test("a 4401 close stops reconnecting and reads offline", () => {
  // The admin session behind the socket ended. Retrying would be a login screen
  // the operator never gets to, once every backoff, forever.
  const stub = installSocketStub();
  const timer = createStubTimer();

  renderWithProviders(<Probe />, { stream: { enabled: true, timer: timer.schedule } });
  act(() => {
    stub.last().open();
    stub.last().ackAll();
  });
  act(() => {
    stub.last().close(4401, "session expired");
  });

  // No timer was ever scheduled, so there is no backoff window to wait out and
  // no wait that could make this pass by accident.
  expect(timer.delays).toEqual([]);
  expect(timer.pending).toBe(0);
  expect(stub.sockets.length).toBe(1);
  expect(read("status")).toBe("offline");
});

test("a 4401 close marks every query stale so the session check runs again", () => {
  // How this surfaces as unauthenticated: the console already funnels one `AUTH`
  // from any query to the router, so the refetch does the routing rather than a
  // second redirect path invented here.
  const client = makeQueryClient();
  client.setQueryData(queryKeys.status, { authenticated: true });
  const stub = installSocketStub();
  const timer = createStubTimer();

  renderWithProviders(<Probe />, { client, stream: { enabled: true, timer: timer.schedule } });
  act(() => {
    stub.last().open();
  });
  act(() => {
    stub.last().close(4401, "session expired");
  });

  expect(client.getQueryState(queryKeys.status)?.isInvalidated).toBe(true);
});

test("an upgrade that never completes falls back to polling and retries, capped at 30s", () => {
  // The proxy that strips `Upgrade`. Everything keeps working on intervals, and
  // the retry curve stops doubling rather than climbing into the hours.
  const stub = installSocketStub();
  const timer = createStubTimer();

  renderWithProviders(<Probe />, { stream: { enabled: true, timer: timer.schedule } });

  const expected = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
  for (let attempt = 0; attempt < expected.length; attempt += 1) {
    act(() => {
      // Closed without ever opening, which is what a refused upgrade looks like.
      stub.last().close(1006, "upgrade failed");
    });
    if (attempt < expected.length - 1) {
      act(() => {
        timer.fire();
      });
    }
  }

  expect(timer.delays).toEqual(expected);
  expect(stub.sockets.length).toBe(expected.length);
  expect(read("status")).toBe("poll");
  expect(read("logs")).toBe("2000");
});

test("two drops inside the minute leave the socket trusted", () => {
  // The control for the test below. Without it, "three drops degrade" would also
  // pass for an implementation that degraded on the first one.
  const stub = installSocketStub();
  const timer = createStubTimer();
  let clock = 0;

  renderWithProviders(<Probe />, {
    stream: { enabled: true, timer: timer.schedule, now: () => clock },
  });

  for (const at of [0, 1_000]) {
    clock = at;
    act(() => {
      stub.last().open();
      stub.last().ackAll();
    });
    act(() => {
      stub.last().close(1006, "dropped");
    });
    act(() => {
      timer.fire();
    });
  }
  act(() => {
    stub.last().open();
    stub.last().ackAll();
  });

  expect(read("status")).toBe("push");
  expect(read("logs")).toBe("false");
});

test("three drops inside the minute put the tab on polling for good", () => {
  const stub = installSocketStub();
  const timer = createStubTimer();
  let clock = 0;

  renderWithProviders(<Probe />, {
    stream: { enabled: true, timer: timer.schedule, now: () => clock },
  });

  for (const at of [0, 1_000, 2_000]) {
    clock = at;
    act(() => {
      stub.last().open();
      stub.last().ackAll();
    });
    act(() => {
      stub.last().close(1006, "dropped");
    });
    act(() => {
      timer.fire();
    });
  }
  // The socket comes back cleanly and is still not trusted as a board's only
  // feed. It stays subscribed — its invalidations land between polls — but the
  // intervals keep running, which is the safe direction to be wrong in.
  act(() => {
    stub.last().open();
    stub.last().ackAll();
  });

  expect(read("status")).toBe("poll");
  expect(read("logs")).toBe("2000");
});

test("a drop that falls outside the minute does not count toward the three", () => {
  const stub = installSocketStub();
  const timer = createStubTimer();
  let clock = 0;

  renderWithProviders(<Probe />, {
    stream: { enabled: true, timer: timer.schedule, now: () => clock },
  });

  for (const at of [0, 1_000, 61_001]) {
    clock = at;
    act(() => {
      stub.last().open();
      stub.last().ackAll();
    });
    act(() => {
      stub.last().close(1006, "dropped");
    });
    act(() => {
      timer.fire();
    });
  }
  act(() => {
    stub.last().open();
    stub.last().ackAll();
  });

  expect(read("status")).toBe("push");
});

test("with the socket switched off, every migrated topic still polls", () => {
  // The fallback anchor, stated once explicitly and enforced structurally
  // everywhere else: `renderWithProviders` mounts no socket unless a test asks
  // for one, so every board test in this suite is already running this case.
  // What is asserted here is that "no socket" produces an interval for each of
  // the topics the console migrated, and never `false` or `0` — `0` would be
  // read by react-query as "as fast as possible" and turn a missing transport
  // into a client hammering the gateway.
  renderWithProviders(<Probe />);

  expect(read("status")).toBe("poll");
  expect(read("logs")).toBe("2000");
  expect(read("console")).toBe("5000");
  expect(read("bare")).toBe("2000");
});

test("a socket is not opened unless a test opts in", () => {
  // The other half of that default: no stub is installed here, so a provider
  // that connected anyway would construct happy-dom's real `ws` client and open
  // a network connection from a unit suite.
  expect(() => renderWithProviders(<Probe />)).not.toThrow();
});

test("with no socket at all, a board really does refetch on its interval", async () => {
  // The anchor above reads the number a board would hand to react-query; this
  // one lets the number do its work, on the real timer, for one interval of the
  // fastest board there is. Without it "the fallback still works" rests on the
  // interval being *plausible* rather than on a second request arriving.
  const stub = createFetchStub({
    "GET /api/logs": () => ({ logs: [] }),
    "GET /api/credentials": () => ({ credentials: [] }),
    "GET /api/keys": () => ({ keys: [] }),
    "GET /api/settings": () => ({ settings: {}, bodyLoggingAllowed: false }),
  });

  renderWithProviders(<LogsBoard />);

  const logCalls = (): number =>
    stub.calls.filter((call) => call.url.startsWith("/api/logs")).length;
  await waitFor(() => expect(logCalls()).toBeGreaterThanOrEqual(1));
  await waitFor(() => expect(logCalls()).toBeGreaterThanOrEqual(2), {
    timeout: LOG_CADENCE_MS * 2,
  });
});
