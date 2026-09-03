import { expect, test } from "bun:test";
import { memoryCoord } from "@omni/coord";
import { captureLogger } from "@omni/testkit";
import { createBroadcaster } from "../../src/stream/broadcaster.ts";
import type { ServerFrame } from "../../src/stream/protocol.ts";
import { createSocketRegistry } from "../../src/stream/registry.ts";
import { createRing } from "../../src/stream/ring.ts";

/**
 * Two gateway processes, each with its own sockets and ring, sharing one
 * coordinator. A frame emitted on one reaches the other's sockets, a stream
 * carries one sequence across both, and a process that joins late still learns
 * which streams have a source.
 */
function node(coord = memoryCoord(), nodeId = "n") {
  const published: ServerFrame[] = [];
  const registry = createSocketRegistry({
    onDetach: () => {},
    logger: captureLogger(),
    now: () => 0,
    schedule: () => () => {},
  });
  const real = registry.publish.bind(registry);
  registry.publish = (topic, frame) => {
    published.push(frame);
    real(topic, frame);
  };
  const ring = createRing({ frames: 10, bytes: 1024 * 1024 });
  const broadcaster = createBroadcaster({
    registry,
    ring,
    coord,
    nodeId,
    now: () => 0,
    schedule: () => () => {},
  });
  return { broadcaster, ring, published, coord };
}

test("an invalidation on one process reaches the other's sockets", async () => {
  const coord = memoryCoord();
  const a = node(coord, "a");
  const b = node(coord, "b");
  a.broadcaster.invalidate("res:usage");
  await Bun.sleep(1);
  expect(b.published).toContainEqual({ type: "event", topic: "res:usage" });
  expect(a.published).toContainEqual({ type: "event", topic: "res:usage" });
});

test("a stream carries one sequence across processes, and each ring records it", async () => {
  const coord = memoryCoord();
  const a = node(coord, "a");
  const b = node(coord, "b");
  a.broadcaster.stream("stream:x", { n: 1 });
  b.broadcaster.stream("stream:x", { n: 2 });
  a.broadcaster.stream("stream:x", { n: 3 });
  await Bun.sleep(1);
  expect(a.ring.head("stream:x")).toBe(3);
  expect(b.ring.head("stream:x")).toBe(3);
  const slice = b.ring.since("stream:x", 1);
  expect(slice.kind === "frames" ? slice.frames.map((f) => f.seq) : slice).toEqual([2, 3]);
});

test("a late-joining process learns the streams already declared", async () => {
  const coord = memoryCoord();
  const a = node(coord, "a");
  a.broadcaster.declareStream("stream:console:a");
  const c = node(coord, "c");
  await Bun.sleep(1);
  expect(c.broadcaster.declared("stream:console:a")).toBe(true);
  expect(a.broadcaster.declared("stream:console:a")).toBe(true);
  expect(c.broadcaster.declared("stream:console:nope")).toBe(false);
});

test("a ring ignores a frame behind its head rather than reordering", () => {
  const ring = createRing({ frames: 10, bytes: 1024 });
  expect(ring.push("t", "a", 5)).toBe(5);
  expect(ring.push("t", "stale", 3)).toBe(5);
  expect(ring.push("t", "b", 6)).toBe(6);
  const slice = ring.since("t", 4);
  expect(slice.kind === "frames" ? slice.frames.map((f) => f.payload) : slice).toEqual(["a", "b"]);
  // Frames before this process subscribed are a gap, never a silent skip.
  expect(ring.since("t", 2).kind).toBe("gap");
});

/**
 * The emit-side coalescer: N invalidations inside one floor publish once,
 * plus one trailing frame — not N. Without it N processes at 100 req/s each
 * publish uncoalesced, which is what the deliver-side floor cannot bound.
 */
test("rapid invalidations publish once per floor, not once each", async () => {
  const coord = memoryCoord();
  let publishes = 0;
  const publish = coord.pubsub.publish.bind(coord.pubsub);
  coord.pubsub.publish = (topic, payload) => {
    if (payload.includes('"res"')) publishes += 1;
    return publish(topic, payload);
  };
  const a = node(coord, "a");
  for (let i = 0; i < 20; i++) a.broadcaster.invalidate("res:logs");
  await Bun.sleep(1);
  // One immediate; the rest fold into a trailing frame the injected
  // scheduler never fires.
  expect(publishes).toBe(1);
});
/**
 * The plugin-channel half of the fan-out.
 *
 * A plugin's `send` names a connection, which is meaningful only on the process
 * that holds it — so a plugin whose panel is connected to another replica could
 * reach nobody. `broadcast` names the topic instead, which every process can
 * resolve against its own sockets.
 */
test("a plugin channel broadcast on one process reaches the other's subscribers", async () => {
  const coord = memoryCoord();
  const a = node(coord, "a");
  const b = node(coord, "b");
  a.broadcaster.channel("plugin:pokemon:activity", { apiKeyId: "k1" });
  await Bun.sleep(1);
  const frame: ServerFrame = {
    type: "event",
    topic: "plugin:pokemon:activity",
    payload: { apiKeyId: "k1" },
  };
  expect(b.published).toContainEqual(frame);
  // The emitting process delivers through the same loop-back rather than
  // locally, so there is one delivery path and no frame arrives twice.
  expect(a.published).toEqual([frame]);
});

/**
 * Deliberately not coalesced, which is the one place this differs from
 * `invalidate`.
 *
 * A `res:*` frame names a resource and the newest one says everything its
 * predecessors did. A channel frame carries a plugin's own payload, and the
 * payload is routinely the identity of the thing that changed — so replacing
 * the pending frame with the newest drops every other key. The rate is the
 * plugin's to bound, exactly as it already is for `send`.
 */
test("channel frames are not folded together: a frame per key survives one floor", async () => {
  const coord = memoryCoord();
  const a = node(coord, "a");
  for (const apiKeyId of ["k1", "k2", "k3"]) {
    a.broadcaster.channel("plugin:pokemon:activity", { apiKeyId });
  }
  await Bun.sleep(1);
  expect(a.published.map((frame) => ("payload" in frame ? frame.payload : null))).toEqual([
    { apiKeyId: "k1" },
    { apiKeyId: "k2" },
    { apiKeyId: "k3" },
  ]);
});
test("a payload that will not serialise is dropped, never thrown back at the plugin", () => {
  /*
    The frame is stringified synchronously inside `PluginChannel.broadcast`, so
    without this a `BigInt` or a circular object throws in the plugin's own
    stack — a 500 from a route, and from a plugin's own timer an uncaught
    exception with the gateway process behind it. `registry.ts` refuses the same
    throw at the same boundary; this path never reaches that encoder, because it
    encodes its own envelope first.
  */
  const a = node(memoryCoord(), "a");
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  expect(() => a.broadcaster.channel("plugin:alpha:s", { n: 1n })).not.toThrow();
  expect(() => a.broadcaster.channel("plugin:alpha:s", circular)).not.toThrow();
  expect(a.published).toEqual([]);
});

test("a stopped broadcaster publishes nothing", () => {
  const a = node(memoryCoord(), "a");
  a.broadcaster.stop();

  a.broadcaster.channel("plugin:alpha:s", { n: 1 });

  expect(a.published).toEqual([]);
});
