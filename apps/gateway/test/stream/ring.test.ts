import { expect, test } from "bun:test";
import { createRing } from "../../src/stream/ring.ts";

const limits = { frames: 4, bytes: 1_000 };

test("push assigns a monotonic sequence per topic", () => {
  const ring = createRing(limits);

  expect(ring.push("stream:console", "a")).toBe(1);
  expect(ring.push("stream:console", "b")).toBe(2);
  // Sequences are per topic, not global: a busy topic must not advance a quiet
  // one's numbering, or every subscriber to the quiet one is told `gap`.
  expect(ring.push("plugin:rc:session:1", "a")).toBe(1);
  expect(ring.head("stream:console")).toBe(2);
});

test("sinceSeq inside the ring replays exactly the frames that were missed", () => {
  const ring = createRing(limits);
  for (const value of ["a", "b", "c"]) ring.push("stream:console", value);

  const slice = ring.since("stream:console", 1);
  expect(slice).toEqual({
    kind: "frames",
    frames: [
      { seq: 2, payload: "b" },
      { seq: 3, payload: "c" },
    ],
  });
});

test("a subscriber that is current gets an empty replay, not a gap", () => {
  const ring = createRing(limits);
  ring.push("stream:console", "a");

  expect(ring.since("stream:console", 1)).toEqual({ kind: "frames", frames: [] });
});

test("sinceSeq older than the oldest retained frame answers gap and never a silent skip", () => {
  // The mutation this guards is the whole point of the class. Returning the
  // frames that remain instead of `gap` is indistinguishable at the far end from
  // a complete replay: the client believes it is current and is quietly missing
  // everything that was evicted.
  const ring = createRing({ frames: 2, bytes: 1_000 });
  for (const value of ["a", "b", "c", "d"]) ring.push("stream:console", value);

  const slice = ring.since("stream:console", 1);
  // Asserted on the variant, not on frame count. An empty replay and a silent
  // skip are the same length.
  expect(slice.kind).toBe("gap");
  expect(slice).toEqual({ kind: "gap", seq: 4 });
});

test("the boundary case replays rather than gapping", () => {
  // The oldest retained frame is exactly the next one the caller needs, so
  // nothing was lost. An off-by-one here reports a gap on a subscriber that was
  // perfectly in step, and every reconnect becomes a full refetch.
  const ring = createRing({ frames: 2, bytes: 1_000 });
  for (const value of ["a", "b", "c"]) ring.push("stream:console", value);

  expect(ring.since("stream:console", 1)).toEqual({
    kind: "frames",
    frames: [
      { seq: 2, payload: "b" },
      { seq: 3, payload: "c" },
    ],
  });
});

test("a sinceSeq ahead of the server is a gap", () => {
  // The client claims to have seen a frame that was never issued — after a
  // restore, or against a different gateway. It is out of step, not current.
  const ring = createRing(limits);
  ring.push("stream:console", "a");

  expect(ring.since("stream:console", 5)).toEqual({ kind: "gap", seq: 1 });
});

test("a topic that has issued nothing replays empty from zero and gaps from anything else", () => {
  const ring = createRing(limits);

  expect(ring.since("stream:console", 0)).toEqual({ kind: "frames", frames: [] });
  expect(ring.since("stream:console", 3)).toEqual({ kind: "gap", seq: 0 });
});

test("the byte cap evicts before the frame cap when frames are large", () => {
  // A console emitting one large stack trace must not pin memory per topic just
  // because it emitted a single frame.
  const ring = createRing({ frames: 100, bytes: 200 });
  const big = "x".repeat(150);

  ring.push("stream:console", big);
  ring.push("stream:console", big);

  // Two frames, well under the frame cap, already over the byte cap.
  expect(ring.since("stream:console", 0).kind).toBe("gap");
  expect(ring.since("stream:console", 1)).toEqual({
    kind: "frames",
    frames: [{ seq: 2, payload: big }],
  });
});

test("a single frame larger than the whole byte cap is still retained", () => {
  // Evicting it would leave a subscriber that is perfectly current unable to be
  // told anything but `gap`, forever, on a topic with one frame in it.
  const ring = createRing({ frames: 10, bytes: 10 });
  const huge = "x".repeat(500);

  ring.push("stream:console", huge);
  expect(ring.since("stream:console", 0)).toEqual({
    kind: "frames",
    frames: [{ seq: 1, payload: huge }],
  });
});

test("reset forgets history without rewinding the sequence", () => {
  // A log file truncated under a watcher. The source lost continuity, so every
  // existing subscriber must be told `gap` — which is exactly true — and the
  // sequence must keep climbing so no seq is ever issued twice.
  const ring = createRing(limits);
  for (const value of ["a", "b"]) ring.push("stream:console", value);

  ring.reset("stream:console");
  expect(ring.head("stream:console")).toBe(2);
  expect(ring.since("stream:console", 1)).toEqual({ kind: "gap", seq: 2 });

  expect(ring.push("stream:console", "c")).toBe(3);
});

test("an unserialisable payload cannot evict good frames", () => {
  const ring = createRing({ frames: 10, bytes: 100 });
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  ring.push("stream:console", "a");
  ring.push("stream:console", circular);

  expect(ring.since("stream:console", 0).kind).toBe("frames");
});
