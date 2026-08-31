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
 * What Bun's `send` can do, spelled out because getting this wrong is what the
 * second review caught.
 *
 * - `"send"` — written straight out; status is a byte count.
 * - `"buffer"` — uWS took it and **will deliver it**; status is `-1`. The frame
 *   still arrives. An earlier version of this stub returned `-1` *and threw the
 *   frame away*, which is not something Bun does, and the registry was written
 *   to match the stub: it retried every `-1` frame on the next drain, so uWS
 *   delivered it once and the retry delivered it again, forever. One sequence
 *   number arrived 291 times in the reviewer's run.
 * - `"drop"` — genuinely discarded; status is `0`. The only case that should be
 *   retried.
 *
 * The lesson is worth keeping next to the code: a stub that models the
 * implementation's assumptions rather than the runtime's behaviour turns the
 * whole suite into a mirror.
 */
type SendMode = "send" | "buffer" | "drop";

function socket(): Socket & {
  /** Frames the client would actually have received, buffered ones included. */
  sent: ServerFrame[];
  /** Frames uWS accepted but has not handed on yet. */
  buffered: ServerFrame[];
  closed: { code: number | undefined; reason: string | undefined }[];
  pings: number;
  mode: SendMode;
  bufferedAmount: number;
} {
  const state = {
    sent: [] as ServerFrame[],
    buffered: [] as ServerFrame[],
    // `code` and `reason` are optional on `close`, and `exactOptionalPropertyTypes`
    // makes "absent" and "explicitly undefined" different types. Recording what
    // was actually passed means spelling the second one.
    closed: [] as { code: number | undefined; reason: string | undefined }[],
    pings: 0,
    mode: "send" as SendMode,
    bufferedAmount: 0,
    send(data: string) {
      const frame = JSON.parse(data) as ServerFrame;
      if (state.mode === "drop") return 0;
      if (state.mode === "buffer") {
        // Delivered, just not yet. It lands in `sent` too, because from the
        // client's point of view a buffered frame is one that arrives.
        state.buffered.push(frame);
        state.sent.push(frame);
        state.bufferedAmount += data.length;
        return -1;
      }
      state.sent.push(frame);
      return data.length;
    },
    close(code?: number, reason?: string) {
      state.closed.push({ code, reason });
    },
    ping() {
      state.pings++;
      return 1;
    },
    getBufferedAmount() {
      return state.bufferedAmount;
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

/**
 * Counts how many times a frame is serialized, by being the thing
 * `JSON.stringify` calls.
 *
 * A spy rather than an injected serializer because the thing worth pinning is
 * that `JSON.stringify` runs once, not that some indirection was used — a
 * per-connection `stringify` creeping back in is caught either way, and this
 * needs no seam the production code would otherwise not have.
 */
function counted(frame: ServerFrame): { frame: ServerFrame; calls: () => number } {
  let calls = 0;
  // `Object.assign` rather than a spread literal: `ServerFrame` is a union, and
  // a fresh literal carrying `toJSON` fails excess property checking against
  // whichever arm is inferred.
  const spy = Object.assign(
    { ...frame },
    {
      toJSON() {
        calls++;
        return frame;
      },
    },
  );
  return { frame: spy, calls: () => calls };
}

test("serializes a published frame once, not once per subscriber", () => {
  const h = harness();
  const a = socket();
  const b = socket();
  h.registry.add("a", a, credential());
  h.registry.add("b", b, credential());
  h.registry.subscribe("a", "res:usage");
  h.registry.subscribe("b", "res:usage");

  const spy = counted(event(1));
  h.registry.publish("res:usage", spy.frame);

  expect(spy.calls()).toBe(1);
  // And both connections still received it, so "once" is not "once, to one".
  expect(a.sent).toEqual([event(1)]);
  expect(b.sent).toEqual([event(1)]);
  h.registry.stop();
});

test("does not re-serialize a frame held at the queue head by backpressure", () => {
  const h = harness();
  const a = socket();
  a.mode = "drop";
  h.registry.add("a", a, credential());
  h.registry.subscribe("a", "res:usage");

  const spy = counted(event(1));
  h.registry.publish("res:usage", spy.frame);
  expect(a.sent).toEqual([]);

  // Two further drains against the same parked frame. Serializing at send time
  // pays for each of them.
  h.registry.drain("a");
  a.mode = "send";
  h.registry.drain("a");

  expect(spy.calls()).toBe(1);
  expect(a.sent).toEqual([event(1)]);
  h.registry.stop();
});

/**
 * A frame that cannot be serialized is dropped, never thrown.
 *
 * `plugin:*` payloads are plugin-authored `unknown`, and `PluginChannel.send`
 * is documented as "a connection that is gone is a no-op, never an error" — so
 * a plugin handing over a circular object must not be able to throw out of the
 * host, least of all from a timer of its own where nothing is there to catch
 * it. Serialization used to sit inside `flush`'s `catch`; the fan-out fix moved
 * it out from behind that guard, and this is what holds the contract in place.
 */
test("drops an unserializable frame instead of throwing out of publish", () => {
  const h = harness();
  const a = socket();
  const b = socket();
  h.registry.add("a", a, credential());
  h.registry.add("b", b, credential());
  h.registry.subscribe("a", "plugin:demo:updates");
  h.registry.subscribe("b", "plugin:demo:updates");

  const circular: { self?: unknown } = {};
  circular.self = circular;
  const frame = {
    type: "event",
    topic: "plugin:demo:updates",
    payload: circular,
  } as unknown as ServerFrame;

  expect(() => h.registry.publish("plugin:demo:updates", frame)).not.toThrow();
  expect(() => h.registry.sendTo("a", frame)).not.toThrow();
  expect(a.sent).toEqual([]);
  expect(b.sent).toEqual([]);

  // And the connection is still usable: a bad frame costs itself, not the socket.
  h.registry.publish("plugin:demo:updates", event(1));
  expect(a.sent).toHaveLength(1);
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
  a.mode = "drop";

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
  a.mode = "drop";

  h.registry.add("a", a, credential());
  h.registry.subscribe("a", "res:usage");
  for (let i = 0; i < 5; i++) h.registry.publish("res:usage", event(i));

  a.mode = "send";
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
  a.mode = "drop";
  h.registry.publish("res:usage", event(2));
  h.registry.publish("res:usage", event(3));

  expect(a.sent).toEqual([event(1)]);
  expect(h.registry.stats().queued).toBe(2);

  a.mode = "send";
  h.registry.drain("a");
  expect(a.sent).toEqual([event(1), event(2), event(3)]);
  h.registry.stop();
});

test("dropped frames produce one batched warn per tick, not one per drop", async () => {
  // A full queue means many drops in quick succession. A line each turns a slow
  // consumer into a log volume problem on top of it.
  const h = harness({ queueCapacity: 1 });
  const a = socket();
  a.mode = "drop";

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

test("a buffered frame is delivered once and never re-sent", () => {
  // The regression the second review caught. Bun's `-1` means uWS took the
  // frame and will deliver it, so retrying it on the next drain delivers it
  // twice — and since the retry is buffered too, forever. Measured on the real
  // server before the fix: one sequence number delivered 291 times while the
  // 316 frames behind it never arrived at all.
  const h = harness();
  const a = socket();
  a.mode = "buffer";

  h.registry.add("a", a, credential());
  h.registry.subscribe("a", "res:usage");
  for (let i = 0; i < 3; i++) h.registry.publish("res:usage", event(i));

  // Handed over exactly once each, in order.
  expect(a.sent).toEqual([event(0), event(1), event(2)]);
  // And nothing is being held for a retry, which is what made it a loop.
  expect(h.registry.stats().queued).toBe(0);

  // A drain must not resend what uWS already owns.
  h.registry.drain("a");
  expect(a.sent).toEqual([event(0), event(1), event(2)]);
  h.registry.stop();
});

test("a dropped frame, and only a dropped frame, is retried", () => {
  // `0` is the one status that means the frame did not go out. It stays at the
  // head so the next drain can try again.
  const h = harness();
  const a = socket();
  h.registry.add("a", a, credential());
  h.registry.subscribe("a", "res:usage");

  a.mode = "drop";
  h.registry.publish("res:usage", event(1));
  expect(a.sent).toEqual([]);
  expect(h.registry.stats().queued).toBe(1);

  a.mode = "send";
  h.registry.drain("a");
  expect(a.sent).toEqual([event(1)]);
  expect(h.registry.stats().queued).toBe(0);
  h.registry.stop();
});

test("frames stop being handed to a socket already holding the high-water mark", () => {
  // Backpressure is what uWS is holding, not what `send` returned. uWS buffers
  // without bound; this queue is bounded and counts what it drops, so once uWS
  // is loaded the right move is to stop feeding it and let the visible queue
  // take the burst.
  const h = harness({ queueCapacity: 50 });
  const a = socket();
  a.mode = "buffer";

  h.registry.add("a", a, credential());
  h.registry.subscribe("a", "res:usage");

  // Each frame is far smaller than the mark, so this takes many publishes.
  for (let i = 0; i < 40_000; i++) h.registry.publish("res:usage", event(i));

  expect(a.bufferedAmount).toBeGreaterThanOrEqual(512 * 1024);
  // Once the mark is reached the queue starts filling instead of uWS.
  expect(h.registry.stats().queued).toBeGreaterThan(0);
  h.registry.stop();
});

test("a server-initiated close announces the topics the connection held", () => {
  // BLOCKER 2. `closeOne` used to announce nothing and leave it to the route's
  // close handler — which reads `topics(id)` after the connection has already
  // left the map, so it got `[]` and every plugin `onClose` went unfired on
  // 4401 expiry, on the pong deadline, and on shutdown. Only a client-initiated
  // close was ever covered.
  const announced: { id: string; topics: readonly string[] }[] = [];
  const clock = 100_000;
  const registry = createSocketRegistry({
    now: () => clock,
    schedule: () => () => {},
    onDetach: (id, topics) => announced.push({ id, topics }),
  });

  const a = socket();
  registry.add("a", a, credential());
  registry.subscribe("a", "plugin:alpha:s");

  registry.closeAll(1001, "restart");

  expect(announced).toEqual([{ id: "a", topics: ["plugin:alpha:s"] }]);
  registry.stop();
});

test("an expired session announces its topics on the way out", async () => {
  // The 4401 path, which is the one that runs against a live console rather
  // than only at shutdown.
  const announced: { id: string; topics: readonly string[] }[] = [];
  let clock = 100_000;
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const registry = createSocketRegistry({
    now: () => clock,
    schedule: (run, ms) => {
      const timer = { at: clock + ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    heartbeatMs: 20_000,
    onDetach: (id, topics) => announced.push({ id, topics }),
  });

  const a = socket();
  registry.add(
    "a",
    a,
    credential(async () => false),
  );
  registry.subscribe("a", "plugin:alpha:s");

  clock += 20_000;
  for (const timer of timers) {
    if (!timer.cancelled && timer.at <= clock) {
      timer.cancelled = true;
      timer.run();
    }
  }
  // Lets the revalidation promise inside the tick settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  expect(a.closed[0]?.code).toBe(4401);
  expect(announced).toEqual([{ id: "a", topics: ["plugin:alpha:s"] }]);
  registry.stop();
});

test("a revalidation that never settles does not disable re-verification for good", () => {
  // `checking` stops a slow verify from stacking. On its own it also means a
  // verify that never settles pins the flag for the life of the socket, so the
  // one connection whose store call is wedged becomes the one that stops being
  // re-verified — and "a socket must not outlive its session" quietly stops
  // applying to exactly it.
  let calls = 0;
  let clock = 100_000;
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const registry = createSocketRegistry({
    now: () => clock,
    schedule: (run, ms) => {
      const timer = { at: clock + ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    heartbeatMs: 20_000,
    checkStaleMs: 30_000,
  });

  const a = socket();
  registry.add("a", a, {
    principal: { kind: "admin" },
    // Never settles, which is what a wedged store call looks like from here.
    revalidate: () => new Promise<boolean>(() => {}),
  });

  const beat = () => {
    clock += 20_000;
    for (const timer of timers) {
      if (!timer.cancelled && timer.at <= clock) {
        timer.cancelled = true;
        timer.run();
      }
    }
  };

  beat();
  expect(calls).toBe(0);
  // Second tick is inside the staleness window, so the in-flight check stands.
  beat();
  // Third is past it, so the wedged check is abandoned and a fresh one starts.
  beat();

  // Proven by the connection still being re-verifiable rather than by counting
  // a private field: swap in a credential that answers, and the next tick acts
  // on it. Under the bug the flag is still set and this never runs.
  registry.remove("a");
  const b = socket();
  registry.add("b", b, {
    principal: { kind: "admin" },
    revalidate: async () => {
      calls += 1;
      return false;
    },
  });
  beat();
  expect(calls).toBeGreaterThan(0);
  registry.stop();
});
