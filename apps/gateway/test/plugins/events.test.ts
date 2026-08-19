import { expect, test } from "bun:test";
import type { RequestCompleted } from "@omni/plugins";
import { createPluginEventBus } from "../../src/plugins/events.ts";

function completed(over: Partial<RequestCompleted> = {}): RequestCompleted {
  return {
    requestId: "req-1",
    apiKeyId: "key-1",
    provider: "anthropic",
    model: "claude-opus-5",
    tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.01,
    durationMs: 100,
    ok: true,
    at: 1_000,
    ...over,
  };
}

/** Lets a test wait for the bus to finish draining without sleeping on a timer. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test("emitting does not run handlers on the caller's stack", async () => {
  // This is the whole reason the bus exists. `finishLog` runs on the request
  // path, and a handler invoked synchronously there would put a plugin's work
  // between a client and its response.
  const bus = createPluginEventBus({});
  const seen: string[] = [];
  bus.onRequestCompleted("p", (e) => seen.push(e.requestId));

  bus.emitRequestCompleted(completed());
  expect(seen).toEqual([]);

  await settle();
  expect(seen).toEqual(["req-1"]);
  bus.stop();
});

test("a throwing handler is contained and does not stop the others", async () => {
  // A plugin's bug must cost that plugin its event and nothing else. Ordering
  // here is deliberate: the thrower is registered first, so a naive
  // implementation loses the second handler entirely.
  const bus = createPluginEventBus({});
  const seen: string[] = [];
  bus.onRequestCompleted("bad", () => {
    throw new Error("plugin bug");
  });
  bus.onRequestCompleted("good", (e) => seen.push(e.requestId));

  bus.emitRequestCompleted(completed());
  await settle();

  expect(seen).toEqual(["req-1"]);
  expect(bus.stats().handlerErrors).toBe(1);
  bus.stop();
});

test("the queue is bounded and drops rather than growing", async () => {
  // An unbounded queue behind a slow handler is a memory leak that only appears
  // under load, which is exactly when it hurts. Dropping is the designed
  // behaviour; the counter is how an operator finds out it happened.
  const bus = createPluginEventBus({ capacity: 3 });
  const seen: string[] = [];
  bus.onRequestCompleted("p", (e) => seen.push(e.requestId));

  for (let i = 0; i < 10; i++) bus.emitRequestCompleted(completed({ requestId: `req-${i}` }));

  expect(bus.stats().dropped).toBe(7);
  await settle();
  expect(seen).toEqual(["req-0", "req-1", "req-2"]);
  bus.stop();
});

test("a plugin only receives events it subscribed to", async () => {
  const bus = createPluginEventBus({});
  const requests: string[] = [];
  const limits: string[] = [];
  bus.onRequestCompleted("p", (e) => requests.push(e.requestId));
  bus.onLimitReached("q", (e) => limits.push(e.apiKeyId));

  bus.emitRequestCompleted(completed());
  bus.emitLimitReached({ apiKeyId: "key-9", dimension: "tokens", window: "1w", at: 5 });
  await settle();

  expect(requests).toEqual(["req-1"]);
  expect(limits).toEqual(["key-9"]);
  bus.stop();
});

test("stop drains nothing further and leaves no timer behind", async () => {
  // Tests in this repo must not leak timers or listeners. A bus that scheduled
  // a drain and was never stopped would keep the loop alive past the test.
  const bus = createPluginEventBus({});
  const seen: string[] = [];
  bus.onRequestCompleted("p", (e) => seen.push(e.requestId));

  bus.emitRequestCompleted(completed());
  bus.stop();
  await settle();

  expect(seen).toEqual([]);
});

test("emitting with no subscribers costs nothing and queues nothing", async () => {
  // The overwhelming majority of installs have no plugins. The bus must not
  // allocate a queue entry per request for an audience of zero.
  const bus = createPluginEventBus({ capacity: 2 });
  for (let i = 0; i < 10; i++) bus.emitRequestCompleted(completed({ requestId: `req-${i}` }));

  expect(bus.stats().dropped).toBe(0);
  expect(bus.stats().queued).toBe(0);
  await settle();
  bus.stop();
});
