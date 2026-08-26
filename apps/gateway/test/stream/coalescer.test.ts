import { expect, test } from "bun:test";
import { createCoalescer, type Schedule } from "../../src/stream/coalescer.ts";

/**
 * A clock and a scheduler a test drives by hand.
 *
 * Timers are not slept on anywhere in this file. The floor being tested is one
 * second; a suite that waited it out would take a minute to assert what an
 * injected clock asserts instantly, and would be flaky besides.
 */
function harness(floors: Record<string, number> = {}, defaultFloorMs = 1_000) {
  let clock = 10_000;
  const sent: { topic: string; payload: unknown }[] = [];
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

  const coalescer = createCoalescer({
    floors,
    defaultFloorMs,
    sink: (topic, payload) => sent.push({ topic, payload }),
    now: () => clock,
    schedule,
  });

  return {
    coalescer,
    sent,
    get cancelled() {
      return cancelled;
    },
    get live() {
      return timers.filter((timer) => !timer.cancelled && timer.at > clock).length;
    },
    /** Advances the clock and fires whatever was due, the way a real loop would. */
    advance(ms: number) {
      clock += ms;
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= clock) {
          timer.cancelled = true;
          timer.run();
        }
      }
    },
  };
}

test("the first emit on a topic passes straight through", () => {
  // Leading, not trailing. An idle gateway's first event must not wait out a
  // floor — low latency on a quiet socket is what this transport was added for.
  const h = harness();
  h.coalescer.emit("res:usage", { keys: ["usage"] });
  expect(h.sent).toEqual([{ topic: "res:usage", payload: { keys: ["usage"] } }]);
});

test("100 emits inside the floor produce exactly one leading and one trailing frame", () => {
  // The mutation this guards: remove the floor and a 100 req/s gateway becomes
  // 100 client refetches per second against a surface that polls at 60s today.
  // Uncoalesced push is strictly worse than the polling it replaces.
  const h = harness({ "res:usage": 1_000 });

  for (let i = 0; i < 100; i++) {
    h.coalescer.emit("res:usage", { n: i });
    h.advance(5);
  }

  expect(h.sent.length).toBe(1);
  h.advance(1_000);
  expect(h.sent.length).toBe(2);
});

test("the trailing frame carries the last payload of the burst, never the first", () => {
  // The last change is the one an operator is watching for. A coalescer that
  // kept the leading payload would show them a number that is already stale and
  // never correct itself.
  const h = harness({ "res:logs": 1_000 });

  h.coalescer.emit("res:logs", { n: 1 });
  h.advance(100);
  h.coalescer.emit("res:logs", { n: 2 });
  h.advance(100);
  h.coalescer.emit("res:logs", { n: 3 });
  h.advance(1_000);

  expect(h.sent).toEqual([
    { topic: "res:logs", payload: { n: 1 } },
    { topic: "res:logs", payload: { n: 3 } },
  ]);
});

test("the trailing frame is never dropped", () => {
  // One emit inside the floor still arrives. A leading-only coalescer would
  // swallow it entirely and the client would never learn the change happened.
  const h = harness({ "res:usage": 1_000 });

  h.coalescer.emit("res:usage", { n: 1 });
  h.advance(999);
  h.coalescer.emit("res:usage", { n: 2 });
  expect(h.sent.length).toBe(1);

  h.advance(1);
  expect(h.sent).toEqual([
    { topic: "res:usage", payload: { n: 1 } },
    { topic: "res:usage", payload: { n: 2 } },
  ]);
});

test("sustained emits keep firing rather than starving under a debounce", () => {
  // Re-arming the timer on every emit would be a debounce, and a debounce under
  // sustained load never fires at all. Emitting every 100ms for ten seconds must
  // deliver roughly one frame per second, not one frame total.
  const h = harness({ "res:logs": 1_000 });

  for (let i = 0; i < 100; i++) {
    h.coalescer.emit("res:logs", { n: i });
    h.advance(100);
  }

  expect(h.sent.length).toBeGreaterThanOrEqual(9);
});

test("each topic keeps its own floor", () => {
  const h = harness({ "res:usage": 1_000, "res:quota": 5_000 });

  h.coalescer.emit("res:usage", 1);
  h.coalescer.emit("res:quota", 1);
  expect(h.sent.length).toBe(2);

  h.coalescer.emit("res:usage", 2);
  h.coalescer.emit("res:quota", 2);
  h.advance(1_000);

  // The 1s topic has fired its trailing frame; the 5s topic has not.
  expect(h.sent.filter((frame) => frame.topic === "res:usage").length).toBe(2);
  expect(h.sent.filter((frame) => frame.topic === "res:quota").length).toBe(1);

  h.advance(4_000);
  expect(h.sent.filter((frame) => frame.topic === "res:quota").length).toBe(2);
});

test("a topic with no configured floor falls back to the default", () => {
  const h = harness({}, 2_000);

  h.coalescer.emit("res:models", 1);
  h.coalescer.emit("res:models", 2);
  h.advance(1_999);
  expect(h.sent.length).toBe(1);

  h.advance(1);
  expect(h.sent.length).toBe(2);
});

test("flush fires every pending trailing emit now", () => {
  const h = harness({ "res:usage": 1_000, "res:keys": 1_000 });

  h.coalescer.emit("res:usage", 1);
  h.coalescer.emit("res:keys", 1);
  h.coalescer.emit("res:usage", 2);
  h.coalescer.emit("res:keys", 2);
  expect(h.sent.length).toBe(2);

  h.coalescer.flush();
  expect(h.sent.length).toBe(4);
  expect(h.live).toBe(0);
});

test("stop cancels every pending trailing timer and delivers nothing further", () => {
  // The `events.ts` discipline: Bun reports nothing for timers through
  // `getActiveResourcesInfo`, so the injected scheduler's cancel is the only
  // thing an assertion can watch.
  const h = harness({ "res:usage": 1_000 });

  h.coalescer.emit("res:usage", 1);
  h.coalescer.emit("res:usage", 2);
  expect(h.cancelled).toBe(0);

  h.coalescer.stop();
  expect(h.cancelled).toBe(1);
  expect(h.live).toBe(0);

  h.advance(5_000);
  expect(h.sent.length).toBe(1);
});
