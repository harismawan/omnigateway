import { expect, test } from "bun:test";
import { captureLogger } from "@omni/testkit";
import type { DrainScheduler } from "../../src/plugins/events.ts";
import { type ChannelSockets, createChannelRegistry } from "../../src/stream/channels.ts";
import type { ServerFrame } from "../../src/stream/protocol.ts";
import { createSocketRegistry, type Socket } from "../../src/stream/registry.ts";
import { streamHarness } from "./harness.ts";

/**
 * A socket slice where one connection holds one topic.
 *
 * Enough for the unit-level assertions, which are about who owns a topic rather
 * than about what a frame does once it is queued.
 */
function sockets(held: Record<string, readonly string[]> = {}): ChannelSockets & {
  sent: { id: string; frame: ServerFrame }[];
} {
  const sent: { id: string; frame: ServerFrame }[] = [];
  return {
    sent,
    has: (id, topic) => (held[id] ?? []).includes(topic),
    sendTo: (id, frame) => {
      sent.push({ id, frame });
    },
  };
}

/** A scheduler a test fires by hand, so a batched report is observable. */
function manualScheduler(): { scheduler: DrainScheduler; run(): void } {
  let pending: (() => void) | undefined;
  return {
    scheduler: (task) => {
      pending = task;
      return () => {
        pending = undefined;
      };
    },
    run() {
      const task = pending;
      pending = undefined;
      task?.();
    },
  };
}

// ------------------------------------------------------------------ namespacing

test("a channel is namespaced with the host's plugin id, and reaches no other plugin's", () => {
  // The plugin supplies the tail of a topic and never the head. Everything else
  // in this feature — the authorisation check, the delivery lookup — reads the
  // topic string, so if this half is wrong nothing downstream can notice.
  const registry = createChannelRegistry({ sockets: sockets(), fanout: () => {} });

  registry.for("alpha").open("session");
  registry.for("beta").open("session");

  expect(registry.opened("plugin:alpha:session")).toBe(true);
  expect(registry.opened("plugin:beta:session")).toBe(true);
  expect(registry.stats().channels).toBe(2);
  registry.stop();
});

test("a plugin cannot name another plugin's topic through the channel name", () => {
  // The interesting attempt, because interior colons are legal: `session:<id>`
  // is the shape the remote-control design uses. A name that looks like a
  // qualified topic still lands under the caller's own id.
  const registry = createChannelRegistry({ sockets: sockets(), fanout: () => {} });

  registry.for("alpha").open("beta:session");

  expect(registry.opened("plugin:alpha:beta:session")).toBe(true);
  expect(registry.opened("plugin:beta:session")).toBe(false);
  registry.stop();
});

test("a channel name outside the pattern throws rather than opening something unreachable", () => {
  // Thrown from `setup`, where the loader turns it into one skipped plugin and
  // one reported reason. A silently mangled name is a channel a client can
  // never subscribe to, which presents as a topic that is merely quiet.
  const registry = createChannelRegistry({ sockets: sockets(), fanout: () => {} });
  const channels = registry.for("alpha");

  for (const name of ["", "Session", "sess ion", "../escape", "a".repeat(65)]) {
    expect(() => channels.open(name)).toThrow();
  }
  expect(registry.stats().channels).toBe(0);
  registry.stop();
});

test("opening the same name twice is the same channel, not a second handler list", () => {
  const registry = createChannelRegistry({
    sockets: sockets({ c1: ["plugin:alpha:s"] }),
    fanout: () => {},
  });
  const seen: unknown[] = [];
  registry
    .for("alpha")
    .open("s")
    .onMessage((message) => seen.push(message.payload));
  registry
    .for("alpha")
    .open("s")
    .onMessage((message) => seen.push(message.payload));

  expect(registry.deliver("plugin:alpha:s", "c1", "hi")).toBe(true);
  // Two handlers on one channel, not one handler on each of two channels.
  expect(seen).toEqual(["hi", "hi"]);
  expect(registry.stats().channels).toBe(1);
  registry.stop();
});

// ------------------------------------------------------------------- delivery

test("a plugin send reaches only a connection that holds the topic", () => {
  const s = sockets({ subscribed: ["plugin:alpha:s"], stranger: ["res:usage"] });
  const registry = createChannelRegistry({ sockets: s, fanout: () => {} });
  const channel = registry.for("alpha").open("s");

  channel.send("subscribed", { n: 1 });
  // A connection that never subscribed, and one that has gone away entirely.
  channel.send("stranger", { n: 2 });
  channel.send("vanished", { n: 3 });

  expect(s.sent).toEqual([
    { id: "subscribed", frame: { type: "event", topic: "plugin:alpha:s", payload: { n: 1 } } },
  ]);
  registry.stop();
});

test("delivery to a topic nothing opened, or from a connection that did not subscribe, is refused", () => {
  const registry = createChannelRegistry({
    sockets: sockets({ c1: ["plugin:alpha:s"] }),
    fanout: () => {},
  });
  registry.for("alpha").open("s");

  expect(registry.deliver("plugin:alpha:s", "c1", "yes")).toBe(true);
  expect(registry.deliver("plugin:alpha:s", "c2", "no")).toBe(false);
  expect(registry.deliver("plugin:nobody:s", "c1", "no")).toBe(false);
  registry.stop();
});

test("a departing connection reaches only the channels it actually held", () => {
  const registry = createChannelRegistry({ sockets: sockets(), fanout: () => {} });
  const closedA: string[] = [];
  const closedB: string[] = [];
  registry
    .for("alpha")
    .open("s")
    .onClose((id) => closedA.push(id));
  registry
    .for("beta")
    .open("s")
    .onClose((id) => closedB.push(id));

  registry.closed("c1", ["res:usage", "plugin:alpha:s"]);

  expect(closedA).toEqual(["c1"]);
  // A console holding no plugin topic must not wake every plugin on the install
  // each time a browser tab closes.
  expect(closedB).toEqual([]);
  registry.stop();
});

// ------------------------------------------------------------------ the bound

test("per-subscriber channel queues drop rather than grow", () => {
  // The bound lives in the socket registry's own per-connection queue, which is
  // the point: there is no second queue here to get a second capacity wrong.
  // A socket reporting backpressure never drains, so every frame after the
  // capacity has to displace one rather than accumulate.
  const capacity = 4;
  const backpressured: Socket & { sent: number } = {
    sent: 0,
    send() {
      // Never reached: `getBufferedAmount` already says uWS is loaded, so the
      // registry stops handing frames over before it calls this.
      return 0;
    },
    close() {},
    ping() {
      return 1;
    },
    // A genuinely stalled consumer, expressed the way the runtime expresses it.
    // An earlier version of this stub returned `-1` from `send` to mean
    // "stalled", which is precisely the misreading that shipped as BLOCKER 1:
    // `-1` means uWS took the frame and will deliver it.
    getBufferedAmount: () => 8 * 1024 * 1024,
  };
  const registry = createSocketRegistry({ queueCapacity: capacity, schedule: () => () => {} });
  registry.add("slow", backpressured, {
    principal: { kind: "admin" },
    revalidate: async () => true,
  });
  registry.subscribe("slow", "plugin:alpha:s");

  const channels = createChannelRegistry({ sockets: registry, fanout: () => {} });
  const channel = channels.for("alpha").open("s");
  for (let n = 0; n < 100; n++) channel.send("slow", { n });

  const stats = registry.stats();
  expect(stats.queued).toBe(capacity);
  expect(stats.dropped).toBe(100 - capacity);
  channels.stop();
  registry.stop();
});

// ---------------------------------------------------------- throwing handlers

test("a throwing message handler is caught and counted against its own plugin", () => {
  const registry = createChannelRegistry({
    fanout: () => {},
    sockets: sockets({ c1: ["plugin:alpha:s", "plugin:beta:s"] }),
  });
  const after: unknown[] = [];
  const alpha = registry.for("alpha").open("s");
  alpha.onMessage(() => {
    throw new Error("boom");
  });
  // A second handler on the same channel still runs: one plugin's broken
  // handler must not cost the channel its other subscribers either.
  alpha.onMessage((message) => after.push(message.payload));
  registry
    .for("beta")
    .open("s")
    .onMessage(() => {
      throw new Error("boom");
    });

  expect(registry.deliver("plugin:alpha:s", "c1", "one")).toBe(true);
  expect(registry.deliver("plugin:beta:s", "c1", "two")).toBe(true);

  expect(after).toEqual(["one"]);
  expect(registry.stats().handlerErrors).toBe(2);
  registry.stop();
});

test("handler failures are reported one batched line per plugin, not one per failure", () => {
  // A handler that always throws throws once per client frame, which on a
  // keystroke channel is many times a second. A line each turns one broken
  // plugin into a log volume problem on top of it.
  const logger = captureLogger();
  const manual = manualScheduler();
  const registry = createChannelRegistry({
    fanout: () => {},
    sockets: sockets({ c1: ["plugin:alpha:s", "plugin:beta:s"] }),
    logger,
    scheduler: manual.scheduler,
  });
  for (const id of ["alpha", "beta"]) {
    registry
      .for(id)
      .open("s")
      .onMessage(() => {
        throw new Error("boom");
      });
  }

  for (let n = 0; n < 20; n++) {
    registry.deliver("plugin:alpha:s", "c1", n);
    registry.deliver("plugin:beta:s", "c1", n);
  }
  // Nothing logged until the report runs: forty failures, no lines yet.
  expect(logger.records).toEqual([]);
  manual.run();

  const lines = logger.records.filter((r) => r.msg === "plugin channel handler failed");
  expect(lines).toHaveLength(2);
  expect(lines.map((line) => line.fields.plugin).sort()).toEqual(["alpha", "beta"]);
  expect(lines.every((line) => line.fields.count === 20)).toBe(true);
  // Nothing from the plugin's own error rides along: `LogFields` is a closed
  // allowlist and this line reports on code authored outside the repository.
  for (const line of lines) {
    expect(Object.keys(line.fields).sort()).toEqual(["count", "plugin"]);
  }
  registry.stop();
});

// --------------------------------------------------------- over a real socket

test("a client send on an opened plugin topic reaches the plugin's onMessage handler", async () => {
  const h = await streamHarness();
  try {
    const received: { connectionId: string; payload: unknown }[] = [];
    const channel = h.channels.for("alpha").open("s");
    channel.onMessage((message) => received.push(message));

    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ id: "1", type: "subscribe", topic: "plugin:alpha:s" });
    await socket.waitFor((f) => isAck(f, "1"), "the subscribe ack");

    socket.send({ id: "2", type: "send", topic: "plugin:alpha:s", payload: { key: "a" } });
    await socket.waitFor((f) => isAck(f, "2"), "the send ack");

    expect(received).toHaveLength(1);
    expect(received[0]?.payload).toEqual({ key: "a" });

    // The plugin answers on the same topic, which is what makes the round trip
    // a channel rather than a one-way drain.
    const connectionId = received[0]?.connectionId ?? "";
    channel.send(connectionId, { echo: "a" });
    const frame = await socket.waitFor(
      (f) => isRecord(f) && f.type === "event" && f.topic === "plugin:alpha:s",
      "the plugin's reply",
    );
    expect(isRecord(frame) ? frame.payload : null).toEqual({ echo: "a" });
  } finally {
    await h.close();
  }
});

test("subscribing to a plugin topic no plugin has opened is refused", async () => {
  // The same rule `stream:*` follows through `declared`: a topic with no owner
  // behind it must not look to a client like one that is merely quiet.
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ id: "1", type: "subscribe", topic: "plugin:ghost:s" });

    const frame = await socket.waitFor((f) => isError(f, "1"), "the refusal");
    expect(isRecord(frame) ? frame.message : "").toBe("not permitted");

    // And the refusal really left no subscription behind. Published against a
    // topic that exists as well, so the assertion is "this one and not that
    // one" rather than a bare absence that a broken socket would also satisfy.
    h.channels.for("real").open("s");
    socket.send({ id: "2", type: "subscribe", topic: "plugin:real:s" });
    await socket.waitFor((f) => isAck(f, "2"), "the second subscribe ack");
    h.registry.publish("plugin:ghost:s", { type: "event", topic: "plugin:ghost:s" });
    h.registry.publish("plugin:real:s", { type: "event", topic: "plugin:real:s" });

    await socket.waitFor(
      (f) => isRecord(f) && f.type === "event" && f.topic === "plugin:real:s",
      "the frame on the topic that exists",
    );
    expect(socket.frames.filter((f) => isRecord(f) && f.topic === "plugin:ghost:s")).toEqual([
      // Only the refusal, never an event.
      expect.objectContaining({ type: "error" }),
    ]);
  } finally {
    await h.close();
  }
});

test("a client send on a non-plugin topic is still read-only", async () => {
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ id: "1", type: "send", topic: "res:usage", payload: { spoof: true } });

    const frame = await socket.waitFor((f) => isError(f, "1"), "the refusal");
    expect(isRecord(frame) ? frame.message : "").toBe("topic is read-only");
  } finally {
    await h.close();
  }
});

test("a client send before subscribing is refused rather than silently accepted", async () => {
  // The plugin's only way to answer publishes on this topic, so a frame from an
  // unsubscribed connection is a question whose answer has nowhere to land.
  const h = await streamHarness();
  try {
    const seen: unknown[] = [];
    h.channels
      .for("alpha")
      .open("s")
      .onMessage((message) => seen.push(message.payload));

    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ id: "1", type: "send", topic: "plugin:alpha:s", payload: { key: "a" } });

    const frame = await socket.waitFor((f) => isError(f, "1"), "the refusal");
    expect(isRecord(frame) ? frame.message : "").toBe("subscribe before sending");
    expect(seen).toEqual([]);
  } finally {
    await h.close();
  }
});

test("a throwing channel handler leaves the connection able to receive the next frame", async () => {
  // The half a naive test omits. Asserting only that nothing threw would pass
  // against a handler failure that had already severed the socket.
  const h = await streamHarness();
  try {
    const channel = h.channels.for("alpha").open("s");
    channel.onMessage(() => {
      throw new Error("boom");
    });

    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ id: "1", type: "subscribe", topic: "plugin:alpha:s" });
    await socket.waitFor((f) => isAck(f, "1"), "the subscribe ack");

    socket.send({ id: "2", type: "send", topic: "plugin:alpha:s", payload: { boom: true } });
    await socket.waitFor((f) => isAck(f, "2"), "the send ack despite the throw");

    // Still open, still subscribed, still served — a subsequent frame arrives.
    h.registry.publish("plugin:alpha:s", {
      type: "event",
      topic: "plugin:alpha:s",
      payload: { after: true },
    });
    const frame = await socket.waitFor(
      (f) => isRecord(f) && f.type === "event" && f.topic === "plugin:alpha:s",
      "a frame after the throwing handler",
    );
    expect(isRecord(frame) ? frame.payload : null).toEqual({ after: true });
    expect(socket.closes).toEqual([]);
    expect(h.channels.stats().handlerErrors).toBe(1);

    h.settle();
    expect(h.logger.records.filter((r) => r.msg === "plugin channel handler failed")).toHaveLength(
      1,
    );
  } finally {
    await h.close();
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAck(frame: unknown, id: string): boolean {
  return isRecord(frame) && frame.type === "ack" && frame.id === id;
}

function isError(frame: unknown, id: string): boolean {
  return isRecord(frame) && frame.type === "error" && frame.id === id;
}

test("a real socket closing fires the plugin's onClose handler", async () => {
  // The route reads the connection's topics and *then* removes it from the
  // registry, and that order is the only thing making this work: `remove`
  // detaches the topic set, so reversing the two lines hands `closed` an empty
  // list and every `onClose` handler goes unfired — with nothing thrown and
  // nothing logged, so a plugin simply never learns the connection ended.
  //
  // The unit test above drives `registry.closed(...)` directly and cannot see
  // that ordering at all. This one goes through the real route and a real
  // socket, which is the only path where the mistake is reachable.
  const h = await streamHarness();
  try {
    const closed: string[] = [];
    const seen: string[] = [];
    const channel = h.channels.for("alpha").open("s");
    channel.onMessage((message) => seen.push(message.connectionId));
    channel.onClose((connectionId) => closed.push(connectionId));

    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ id: "1", type: "subscribe", topic: "plugin:alpha:s" });
    await socket.waitFor((f) => isAck(f, "1"), "the subscribe ack");

    // One round trip, purely to learn the connection id the host assigned and
    // to prove the subscription is real before the close is asked to notice it.
    // Without this the test could pass against a connection that never held the
    // topic — which is precisely the state the bug produces.
    socket.send({ id: "2", type: "send", topic: "plugin:alpha:s", payload: null });
    await socket.waitFor((f) => isAck(f, "2"), "the send ack");
    const connectionId = seen[0] ?? "";
    expect(h.registry.topics(connectionId)).toContain("plugin:alpha:s");

    socket.close();

    const deadline = Date.now() + 2_000;
    while (closed.length === 0 && Date.now() < deadline) await Bun.sleep(5);

    expect(closed).toEqual([connectionId]);
  } finally {
    await h.close();
  }
});

test("unsubscribing from a plugin topic fires the plugin's onClose handler", async () => {
  // A panel that unmounts while the tab stays open. Before the console could
  // subscribe to a plugin topic at all this was unreachable, so `closed` was
  // called from the socket's close handler and nowhere else — which left a
  // plugin holding a session for a connection that had stopped listening, for
  // the life of the tab.
  //
  // The guard is what makes the ordering load-bearing here: `registry.has` is
  // asked before `registry.unsubscribe` detaches the topic, so running the two
  // the other way round means the connection no longer holds it, the guard
  // refuses, and every handler goes unfired with nothing to say so.
  const h = await streamHarness();
  try {
    const closed: string[] = [];
    const seen: string[] = [];
    const channel = h.channels.for("alpha").open("s");
    channel.onMessage((message) => seen.push(message.connectionId));
    channel.onClose((connectionId) => closed.push(connectionId));

    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ id: "1", type: "subscribe", topic: "plugin:alpha:s" });
    await socket.waitFor((f) => isAck(f, "1"), "the subscribe ack");
    // Establishes the connection id and proves the subscription is real, for
    // the reason the close test gives: without it this would pass against a
    // connection that never held the topic.
    socket.send({ id: "2", type: "send", topic: "plugin:alpha:s", payload: null });
    await socket.waitFor((f) => isAck(f, "2"), "the send ack");
    const connectionId = seen[0] ?? "";

    socket.send({ id: "3", type: "unsubscribe", topic: "plugin:alpha:s" });
    await socket.waitFor((f) => isAck(f, "3"), "the unsubscribe ack");

    expect(closed).toEqual([connectionId]);
    // The socket is still open and still usable. An unsubscribe is a panel
    // unmounting, not a tab closing, and the console holds other topics on the
    // same connection.
    expect(socket.closes).toEqual([]);
    socket.send({ id: "4", type: "subscribe", topic: "plugin:alpha:s" });
    await socket.waitFor((f) => isAck(f, "4"), "the resubscribe ack");
  } finally {
    await h.close();
  }
});

test("unsubscribing fires onClose once, and the later socket close does not fire it again", async () => {
  // The `has` guard from the other side. Without it the close handler reports a
  // topic the connection had already given up, so a plugin that opened a
  // session on subscribe and dropped it on close would drop it twice — and the
  // second drop lands on whatever session took its place.
  const h = await streamHarness();
  try {
    const closed: string[] = [];
    const seen: string[] = [];
    const channel = h.channels.for("alpha").open("s");
    channel.onMessage((message) => seen.push(message.connectionId));
    channel.onClose((connectionId) => closed.push(connectionId));

    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ id: "1", type: "subscribe", topic: "plugin:alpha:s" });
    await socket.waitFor((f) => isAck(f, "1"), "the subscribe ack");
    socket.send({ id: "2", type: "send", topic: "plugin:alpha:s", payload: null });
    await socket.waitFor((f) => isAck(f, "2"), "the send ack");

    socket.send({ id: "3", type: "unsubscribe", topic: "plugin:alpha:s" });
    await socket.waitFor((f) => isAck(f, "3"), "the unsubscribe ack");
    expect(closed).toHaveLength(1);

    socket.close();
    // Long enough that a second call would have landed: the close path is what
    // the surrounding tests wait on the same way.
    const deadline = Date.now() + 500;
    while (closed.length < 2 && Date.now() < deadline) await Bun.sleep(5);

    expect(closed).toEqual([seen[0] ?? ""]);
  } finally {
    await h.close();
  }
});

test("unsubscribing from a plugin topic the connection never held fires nothing", async () => {
  // An unsubscribe is not a request to be told about a channel. Firing on one
  // the connection never held would hand a plugin an `onClose` for a session it
  // never opened, which is worse than silence: it names a connection id the
  // plugin has no record of.
  const h = await streamHarness();
  try {
    const closed: string[] = [];
    h.channels
      .for("alpha")
      .open("s")
      .onClose((connectionId) => closed.push(connectionId));

    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ id: "1", type: "unsubscribe", topic: "plugin:alpha:s" });
    await socket.waitFor((f) => isAck(f, "1"), "the unsubscribe ack");

    expect(closed).toEqual([]);
  } finally {
    await h.close();
  }
});

test("a 4401 session expiry fires the plugin's onClose handler", async () => {
  // The second review's probe, kept. The first review's test covers a
  // client-initiated close and cannot see this path: the registry closes the
  // socket itself here, so nothing about the route's ordering is involved.
  const h = await streamHarness();
  try {
    const closed: string[] = [];
    const seen: string[] = [];
    const channel = h.channels.for("alpha").open("s");
    channel.onMessage((message) => seen.push(message.connectionId));
    channel.onClose((connectionId) => closed.push(connectionId));

    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ id: "1", type: "subscribe", topic: "plugin:alpha:s" });
    await socket.waitFor((f) => isAck(f, "1"), "the subscribe ack");
    socket.send({ id: "2", type: "send", topic: "plugin:alpha:s", payload: null });
    await socket.waitFor((f) => isAck(f, "2"), "the send ack");
    const connectionId = seen[0] ?? "";

    // Ending the session is what a restore does, and what a 12h expiry does.
    await fetch(`http://127.0.0.1:${h.port}/api/logout`, {
      method: "POST",
      headers: { cookie: h.cookie },
    });
    await h.beat();

    const closure = await socket.waitForClose("the 4401 close");
    expect(closure.code).toBe(4401);
    expect(closed).toEqual([connectionId]);
  } finally {
    await h.close();
  }
});

test("a shutdown closeAll fires the plugin's onClose handler", async () => {
  // What a gateway restart does. Left unfired, a plugin goes on believing every
  // session it was serving is still live — which for the remote-control plugin
  // this transport exists to unblock is the difference between reconnecting a
  // session and orphaning it.
  const h = await streamHarness();
  try {
    const closed: string[] = [];
    const seen: string[] = [];
    const channel = h.channels.for("alpha").open("s");
    channel.onMessage((message) => seen.push(message.connectionId));
    channel.onClose((connectionId) => closed.push(connectionId));

    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ id: "1", type: "subscribe", topic: "plugin:alpha:s" });
    await socket.waitFor((f) => isAck(f, "1"), "the subscribe ack");
    socket.send({ id: "2", type: "send", topic: "plugin:alpha:s", payload: null });
    await socket.waitFor((f) => isAck(f, "2"), "the send ack");
    const connectionId = seen[0] ?? "";

    // Exactly what the `stopLoops` entry runs at teardown.
    h.registry.closeAll(1001, "restart");

    const closure = await socket.waitForClose("the 1001 close");
    expect(closure.code).toBe(1001);
    expect(closed).toEqual([connectionId]);
  } finally {
    await h.close();
  }
});

test("a pong deadline close fires the plugin's onClose handler", async () => {
  const h = await streamHarness({ heartbeatMs: 1_000, pongDeadlineMs: 500 });
  try {
    const closed: string[] = [];
    const seen: string[] = [];
    const channel = h.channels.for("alpha").open("s");
    channel.onMessage((message) => seen.push(message.connectionId));
    channel.onClose((connectionId) => closed.push(connectionId));

    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ id: "1", type: "subscribe", topic: "plugin:alpha:s" });
    await socket.waitFor((f) => isAck(f, "1"), "the subscribe ack");
    socket.send({ id: "2", type: "send", topic: "plugin:alpha:s", payload: null });
    await socket.waitFor((f) => isAck(f, "2"), "the send ack");
    const connectionId = seen[0] ?? "";

    // The injected clock jumps past the deadline without a pong arriving.
    await h.beat();
    await h.beat();

    expect(closed).toEqual([connectionId]);
  } finally {
    await h.close();
  }
});
// ------------------------------------------------------------------ broadcast

test("a broadcast leaves through the fan-out and is not also delivered locally", () => {
  // The fan-out loops back into this process's own socket registry, so a local
  // send here as well would deliver every frame twice to a panel on this pod.
  const s = sockets({ subscribed: ["plugin:alpha:s"] });
  const fanned: { topic: string; payload: unknown }[] = [];
  const registry = createChannelRegistry({
    sockets: s,
    fanout: (topic, payload) => fanned.push({ topic, payload }),
  });

  registry.for("alpha").open("s").broadcast?.({ n: 1 });

  expect(fanned).toEqual([{ topic: "plugin:alpha:s", payload: { n: 1 } }]);
  expect(s.sent).toEqual([]);
  registry.stop();
});

test("a broadcast carries the plugin's own topic and no other's", () => {
  const fanned: string[] = [];
  const registry = createChannelRegistry({
    sockets: sockets(),
    fanout: (topic) => fanned.push(topic),
  });

  registry.for("alpha").open("beta:s").broadcast?.({});
  registry.for("beta").open("s").broadcast?.({});

  expect(fanned).toEqual(["plugin:alpha:beta:s", "plugin:beta:s"]);
  registry.stop();
});

test("a stopped registry broadcasts nothing", () => {
  const fanned: string[] = [];
  const registry = createChannelRegistry({
    sockets: sockets(),
    fanout: (topic) => fanned.push(topic),
  });
  const channel = registry.for("alpha").open("s");

  registry.stop();
  channel.broadcast?.({ n: 1 });

  expect(fanned).toEqual([]);
});
test("a channel over its budget drops the excess and reports it once", () => {
  // `send` is one push into one bounded queue on this process; a broadcast is a
  // publish plus work on every replica, and it deliberately goes past the
  // emit-side coalescer. The cap is what keeps "past the coalescer" from meaning
  // "unbounded".
  const logger = captureLogger();
  const manual = manualScheduler();
  let clock = 1_000;
  const fanned: unknown[] = [];
  const registry = createChannelRegistry({
    sockets: sockets(),
    fanout: (_topic, payload) => fanned.push(payload),
    logger,
    scheduler: manual.scheduler,
    now: () => clock,
    burst: 3,
  });
  const channel = registry.for("alpha").open("s");

  for (let i = 0; i < 10; i++) channel.broadcast?.({ i });

  expect(fanned).toHaveLength(3);
  expect(registry.stats().broadcastDrops).toBe(7);
  // One line for the burst, not seven.
  manual.run();
  expect(
    logger.records.filter((record) => record.msg === "plugin channel broadcast dropped"),
  ).toEqual([
    {
      level: "warn",
      msg: "plugin channel broadcast dropped",
      fields: { plugin: "alpha", count: 7 },
    },
  ]);

  // Refilled continuously rather than per window, so a plugin holding at its
  // budget is never cut off for the tail of a second — the frame a panel is
  // waiting for is the last of a burst.
  clock += 1_000;
  channel.broadcast?.({ i: "later" });
  expect(fanned).toHaveLength(4);
  registry.stop();
});

test("one channel's budget is not another's", () => {
  const fanned: string[] = [];
  const registry = createChannelRegistry({
    sockets: sockets(),
    fanout: (topic) => fanned.push(topic),
    // Frozen, so neither channel refills: the budgets are separate or this test
    // cannot tell the difference.
    now: () => 0,
    burst: 1,
  });

  registry.for("alpha").open("s").broadcast?.({});
  registry.for("alpha").open("s").broadcast?.({});
  registry.for("beta").open("s").broadcast?.({});

  // A noisy plugin cannot spend a quiet one's budget.
  expect(fanned).toEqual(["plugin:alpha:s", "plugin:beta:s"]);
  registry.stop();
});
