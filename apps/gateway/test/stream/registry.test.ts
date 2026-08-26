import { expect, test } from "bun:test";
import { captureLogger } from "@omni/testkit";
import type { Schedule } from "../../src/stream/coalescer.ts";
import type { ServerFrame } from "../../src/stream/protocol.ts";
import {
  CLOSE_UNAUTHENTICATED,
  type Credential,
  createSocketRegistry,
  type Socket,
} from "../../src/stream/registry.ts";

/**
 * A socket a test drives.
 *
 * `accepting` models Bun's backpressure status: `send` reports whether a frame
 * went out rather than blocking on it, so a slow consumer is a socket that
 * keeps returning a non-positive status.
 */
function socket(): Socket & {
  sent: ServerFrame[];
  closed: { code: number | undefined; reason: string | undefined }[];
  pings: number;
  accepting: boolean;
} {
  const state = {
    sent: [] as ServerFrame[],
    // `code` and `reason` are optional on `close`, and `exactOptionalPropertyTypes`
    // makes "absent" and "explicitly undefined" different types. Recording what
    // was actually passed means spelling the second one.
    closed: [] as { code: number | undefined; reason: string | undefined }[],
    pings: 0,
    accepting: true,
    send(data: string) {
      if (!state.accepting) return -1;
      state.sent.push(JSON.parse(data) as ServerFrame);
      return data.length;
    },
    close(code?: number, reason?: string) {
      state.closed.push({ code, reason });
    },
    ping() {
      state.pings++;
      return 1;
    },
  };
  return state;
}

function credential(revalidate: () => Promise<boolean> = async () => true): Credential {
  return { principal: { kind: "admin" }, revalidate };
}

function harness(over: { queueCapacity?: number; pongDeadlineMs?: number } = {}) {
  let clock = 100_000;
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  let cancelled = 0;

  const schedule: Schedule = (run, ms) => {
    const timer = { at: clock + ms, run, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
      cancelled++;
    };
  };

  const logger = captureLogger();
  const registry = createSocketRegistry({
    logger,
    now: () => clock,
    schedule,
    heartbeatMs: 20_000,
    ...over,
  });

  return {
    registry,
    logger,
    get cancelled() {
      return cancelled;
    },
    get live() {
      return timers.filter((timer) => !timer.cancelled && timer.at > clock).length;
    },
    /** Advances to the next heartbeat and lets any revalidation settle. */
    async beat() {
      clock += 20_000;
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= clock) {
          timer.cancelled = true;
          timer.run();
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

const event = (n: number): ServerFrame => ({ type: "event", topic: "res:usage", payload: { n } });

test("a published frame reaches every subscriber to that topic and no others", () => {
  const h = harness();
  const a = socket();
  const b = socket();
  const c = socket();

  h.registry.add("a", a, credential());
  h.registry.add("b", b, credential());
  h.registry.add("c", c, credential());
  h.registry.subscribe("a", "res:usage");
  h.registry.subscribe("b", "res:usage");
  h.registry.subscribe("c", "res:logs");

  h.registry.publish("res:usage", event(1));

  expect(a.sent).toEqual([event(1)]);
  expect(b.sent).toEqual([event(1)]);
  expect(c.sent).toEqual([]);
  h.registry.stop();
});

test("unsubscribe removes only that topic's index entry", () => {
  const h = harness();
  const a = socket();
  h.registry.add("a", a, credential());
  h.registry.subscribe("a", "res:usage");
  h.registry.subscribe("a", "res:logs");

  h.registry.unsubscribe("a", "res:usage");
  h.registry.publish("res:usage", event(1));
  h.registry.publish("res:logs", event(2));

  expect(a.sent).toEqual([event(2)]);
  expect(h.registry.topics("a")).toEqual(["res:logs"]);
  h.registry.stop();
});

test("removing a connection clears it from every topic it held", () => {
  const h = harness();
  const a = socket();
  h.registry.add("a", a, credential());
  h.registry.subscribe("a", "res:usage");

  h.registry.remove("a");
  h.registry.publish("res:usage", event(1));

  expect(a.sent).toEqual([]);
  expect(h.registry.stats().connections).toBe(0);
  h.registry.stop();
});

test("a slow consumer drops oldest, increments the counter, and the queue does not grow", () => {
  // Two assertions, and both are needed. Checking only the queue length lets a
  // mutation that drops without counting pass, and the counter is the only way
  // an operator learns this happened at all.
  const h = harness({ queueCapacity: 3 });
  const a = socket();
  a.accepting = false;

  h.registry.add("a", a, credential());
  h.registry.subscribe("a", "res:usage");
  for (let i = 0; i < 10; i++) h.registry.publish("res:usage", event(i));

  expect(h.registry.stats().queued).toBe(3);
  expect(h.registry.stats().dropped).toBe(7);
  expect(a.sent).toEqual([]);
  h.registry.stop();
});

test("the frames kept under pressure are the newest ones", () => {
  // On a transport whose whole point is currency, a queue that dropped the
  // newest frame would deliver a stale view and then stop.
  const h = harness({ queueCapacity: 2 });
  const a = socket();
  a.accepting = false;

  h.registry.add("a", a, credential());
  h.registry.subscribe("a", "res:usage");
  for (let i = 0; i < 5; i++) h.registry.publish("res:usage", event(i));

  a.accepting = true;
  h.registry.drain("a");

  expect(a.sent).toEqual([event(3), event(4)]);
  h.registry.stop();
});

test("a backpressured connection stops draining rather than reordering", () => {
  // On `stream:*` the sequence is the contract, so sending the frames behind a
  // stuck one would be worse than sending nothing.
  const h = harness();
  const a = socket();
  h.registry.add("a", a, credential());
  h.registry.subscribe("a", "res:usage");

  h.registry.publish("res:usage", event(1));
  a.accepting = false;
  h.registry.publish("res:usage", event(2));
  h.registry.publish("res:usage", event(3));

  expect(a.sent).toEqual([event(1)]);
  expect(h.registry.stats().queued).toBe(2);

  a.accepting = true;
  h.registry.drain("a");
  expect(a.sent).toEqual([event(1), event(2), event(3)]);
  h.registry.stop();
});

test("dropped frames produce one batched warn per tick, not one per drop", async () => {
  // A full queue means many drops in quick succession. A line each turns a slow
  // consumer into a log volume problem on top of it.
  const h = harness({ queueCapacity: 1 });
  const a = socket();
  a.accepting = false;

  h.registry.add("a", a, credential());
  h.registry.subscribe("a", "res:usage");
  for (let i = 0; i < 20; i++) h.registry.publish("res:usage", event(i));

  await h.beat();

  const warns = h.logger.records.filter((entry) => entry.msg === "stream queue overflowed");
  expect(warns.length).toBe(1);
  expect(warns[0]?.fields).toMatchObject({ count: 19 });
  h.registry.stop();
});

test("a connection whose revalidate resolves false is closed 4401", async () => {
  // The exact code is the assertion. `4401` alone tells the client to
  // authenticate again rather than reconnect; a mutation to 1008 or 1000 puts it
  // into its ordinary backoff loop against a gateway that will refuse it every
  // single time.
  const h = harness();
  const a = socket();
  h.registry.add(
    "a",
    a,
    credential(async () => false),
  );
  h.registry.subscribe("a", "res:usage");

  await h.beat();

  // The literal, deliberately, and not the imported constant. Comparing against
  // `CLOSE_UNAUTHENTICATED` makes the assertion move with the mutation: change
  // the constant to 1008 and a test written that way still passes while every
  // client silently drops into a reconnect loop it can never escape.
  expect(a.closed).toEqual([{ code: 4401, reason: "session expired" }]);
  expect(CLOSE_UNAUTHENTICATED).toBe(4401);
  expect(h.registry.stats().connections).toBe(0);
  h.registry.stop();
});

test("a connection whose session is still valid is left alone", async () => {
  const h = harness();
  const a = socket();
  h.registry.add("a", a, credential());

  await h.beat();

  expect(a.closed).toEqual([]);
  expect(a.pings).toBe(1);
  h.registry.stop();
});

test("a revalidation that throws does not disconnect anyone", async () => {
  // A verify that threw is not a verify that failed. Closing here would drop
  // every console in the building the moment the store had a bad second.
  const h = harness();
  const a = socket();
  h.registry.add(
    "a",
    a,
    credential(async () => {
      throw new Error("store busy");
    }),
  );

  await h.beat();

  expect(a.closed).toEqual([]);
  expect(h.registry.stats().connections).toBe(1);
  h.registry.stop();
});

test("a connection that stops ponging is closed at the deadline", async () => {
  const h = harness({ pongDeadlineMs: 30_000 });
  const a = socket();
  h.registry.add("a", a, credential());

  await h.beat();
  expect(a.closed).toEqual([]);

  await h.beat();
  expect(a.closed).toEqual([{ code: 1001, reason: "pong deadline" }]);
  h.registry.stop();
});

test("a pong keeps a connection past the deadline", async () => {
  const h = harness({ pongDeadlineMs: 30_000 });
  const a = socket();
  h.registry.add("a", a, credential());

  await h.beat();
  h.registry.pong("a");
  await h.beat();

  expect(a.closed).toEqual([]);
  h.registry.stop();
});

test("closeAll closes every connection and clears the topic index", () => {
  const h = harness();
  const a = socket();
  const b = socket();
  h.registry.add("a", a, credential());
  h.registry.add("b", b, credential());
  h.registry.subscribe("a", "res:usage");
  h.registry.subscribe("b", "res:usage");

  h.registry.closeAll(1001, "restart");

  expect(a.closed).toEqual([{ code: 1001, reason: "restart" }]);
  expect(b.closed).toEqual([{ code: 1001, reason: "restart" }]);
  expect(h.registry.stats().connections).toBe(0);

  // Nothing left in the index to publish to.
  h.registry.publish("res:usage", event(1));
  expect(a.sent).toEqual([]);
  h.registry.stop();
});

test("stop cancels the heartbeat and leaves no timer", () => {
  const h = harness();
  expect(h.live).toBe(1);

  h.registry.stop();

  expect(h.cancelled).toBe(1);
  expect(h.live).toBe(0);
});

test("a connection added after stop is refused rather than orphaned", () => {
  // Shutdown races an upgrade that was already in flight. Accepting it would
  // leave a socket nothing will ever close.
  const h = harness();
  h.registry.stop();

  const a = socket();
  h.registry.add("a", a, credential());

  expect(a.closed).toEqual([{ code: 1001, reason: "shutting down" }]);
  expect(h.registry.stats().connections).toBe(0);
});

test("the principal is readable per connection and the machine arm is representable", () => {
  const h = harness();
  const a = socket();
  const b = socket();
  h.registry.add("a", a, credential());
  h.registry.add("b", b, {
    principal: { kind: "machine", tokenId: "t1", pluginId: "rc" },
    revalidate: async () => true,
  });

  expect(h.registry.principal("a")).toEqual({ kind: "admin" });
  expect(h.registry.principal("b")).toEqual({
    kind: "machine",
    tokenId: "t1",
    pluginId: "rc",
  });
  expect(h.registry.principal("missing")).toBeNull();
  h.registry.stop();
});

test("a send that throws does not remove the connection out from under its close handler", () => {
  const h = harness();
  const a = socket();
  a.send = () => {
    throw new Error("socket gone");
  };
  h.registry.add("a", a, credential());
  h.registry.subscribe("a", "res:usage");

  h.registry.publish("res:usage", event(1));

  // Removal is the close handler's job. Doing it here would race that path.
  expect(h.registry.stats().connections).toBe(1);
  h.registry.stop();
});
