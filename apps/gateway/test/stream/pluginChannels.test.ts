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
    topics: (id) => held[id] ?? [],
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
  const registry = createChannelRegistry({ sockets: sockets() });

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
  const registry = createChannelRegistry({ sockets: sockets() });

  registry.for("alpha").open("beta:session");

  expect(registry.opened("plugin:alpha:beta:session")).toBe(true);
  expect(registry.opened("plugin:beta:session")).toBe(false);
  registry.stop();
});

test("a channel name outside the pattern throws rather than opening something unreachable", () => {
  // Thrown from `setup`, where the loader turns it into one skipped plugin and
  // one reported reason. A silently mangled name is a channel a client can
  // never subscribe to, which presents as a topic that is merely quiet.
  const registry = createChannelRegistry({ sockets: sockets() });
  const channels = registry.for("alpha");

  for (const name of ["", "Session", "sess ion", "../escape", "a".repeat(65)]) {
    expect(() => channels.open(name)).toThrow();
  }
  expect(registry.stats().channels).toBe(0);
  registry.stop();
});

test("opening the same name twice is the same channel, not a second handler list", () => {
  const registry = createChannelRegistry({ sockets: sockets({ c1: ["plugin:alpha:s"] }) });
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
  const registry = createChannelRegistry({ sockets: s });
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
  const registry = createChannelRegistry({ sockets: sockets({ c1: ["plugin:alpha:s"] }) });
  registry.for("alpha").open("s");

  expect(registry.deliver("plugin:alpha:s", "c1", "yes")).toBe(true);
  expect(registry.deliver("plugin:alpha:s", "c2", "no")).toBe(false);
  expect(registry.deliver("plugin:nobody:s", "c1", "no")).toBe(false);
  registry.stop();
});

test("a departing connection reaches only the channels it actually held", () => {
  const registry = createChannelRegistry({ sockets: sockets() });
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
      // Bun reports backpressure as a non-positive status rather than blocking.
      return -1;
    },
    close() {},
    ping() {
      return 1;
    },
  };
  const registry = createSocketRegistry({ queueCapacity: capacity, schedule: () => () => {} });
  registry.add("slow", backpressured, {
    principal: { kind: "admin" },
    revalidate: async () => true,
  });
  registry.subscribe("slow", "plugin:alpha:s");

  const channels = createChannelRegistry({ sockets: registry });
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
