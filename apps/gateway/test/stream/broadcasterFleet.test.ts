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
