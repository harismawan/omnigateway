import { expect, test } from "bun:test";
import { noopLogger } from "@omni/ir";
import { createCaptureBudget } from "../../src/bodies/budget.ts";
import { createBodyWriterHost } from "../../src/bodies/host.ts";
import type { MainMessage, WorkerMessage } from "../../src/bodies/protocol.ts";
import type { CapturedParts } from "../../src/bodyCapture.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const parts = (id = "req", text = "hello"): CapturedParts => ({
  requestId: id,
  at: 1000,
  client: { request: text, response: null, truncated: false },
  attempts: [],
  error: null,
  abandoned: null,
  reservedBytes: Buffer.byteLength(text),
});

test("sustained overflow retains no captures or messages, even with a blocked failure write", async () => {
  let finishFailure = () => {};
  const blocked = new Promise<void>((resolve) => {
    finishFailure = resolve;
  });
  const f = fixture(() => blocked);
  await f.host.start();
  for (let i = 0; i < 1000; i++) {
    const p = parts(`req_${i}`);
    f.budget.reserve(p.reservedBytes);
    f.host.enqueue(p);
  }
  for (let wave = 0; wave < 10; wave++) {
    for (let i = 0; i < 1000; i++) {
      const p = parts(`overflow_${wave}_${i}`);
      p.client.response = ["frame"];
      p.attempts = [
        {
          attempt: 1,
          provider: "anthropic",
          request: "wire",
          response: ["reply"],
          streamChunks: ["frame"],
          truncated: false,
        },
      ];
      p.error = { payload: "must not be retained" };
      f.budget.reserve(p.reservedBytes);
      f.host.enqueue(p);
      expect(p).toMatchObject({
        reservedBytes: 0,
        client: { request: null, response: null },
        attempts: [],
        error: null,
      });
    }
    await tick();
    expect(f.failed).toHaveLength(1);
    expect(f.sent.some((m) => "requestId" in m && m.requestId.startsWith("overflow_"))).toBe(false);
    expect(f.dropped).toHaveLength((wave + 1) * 1000);
    expect(f.dropped.every((reason) => reason === "backlog")).toBe(true);
  }
  // The first five-byte encode is also held until the stalled worker acks it.
  expect(f.budget.held()).toBeLessThanOrEqual(10000);
  f.exit();
  // Crash visits exactly the 1000 admitted entries, never any overflow bookkeeping.
  expect(f.dropped.filter((reason) => reason === "writer_crash")).toHaveLength(1000);
  await tick();
  expect(f.failed).toHaveLength(1);
  expect(f.budget.held()).toBe(0);
  finishFailure();
  await tick();
  expect(f.failed).toHaveLength(1); // No deferred queue of rejected ids.
  f.host.stop();
});

function fixture(fail?: () => Promise<void>) {
  const budget = createCaptureBudget(256 * 1024 * 1024);
  const sent: MainMessage[] = [];
  let message = (_m: WorkerMessage) => {};
  let exit = () => {};
  const failed: string[] = [];
  const published: string[] = [];
  const dropped: string[] = [];
  let yields = 0;
  const host = createBodyWriterHost({
    spawn: () => ({
      post: (m) => sent.push(m),
      onMessage: (fn) => {
        message = fn;
      },
      onExit: (fn) => {
        exit = fn;
      },
      terminate: () => {},
    }),
    bodies: {
      publish: async (r) => {
        published.push(r.requestId);
        return true;
      },
      fail: async (id) => {
        failed.push(id);
        await fail?.();
      },
    },
    budget,
    logger: noopLogger,
    now: Date.now,
    timers: { setTimeout, clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    yield: async () => {
      yields++;
      await tick();
    },
    onDropped: (reason) => dropped.push(reason),
  });
  return {
    host,
    budget,
    sent,
    failed,
    published,
    dropped,
    message: (m: WorkerMessage) => message(m),
    exit: () => exit(),
    yields: () => yields,
  };
}

test("an admitted budget omission still reaches the writer", async () => {
  const f = fixture();
  await f.host.start();
  const p = parts("budget", "");
  p.abandoned = "budget";
  f.host.enqueue(p);
  await tick();
  expect(f.sent).toEqual([
    expect.objectContaining({ type: "meta", requestId: "budget", abandoned: "budget" }),
  ]);
  expect(f.dropped).toEqual([]);
  f.host.stop();
});

test("enqueue returns immediately; slices are bounded, yielded, and reserved until acknowledgements", async () => {
  const f = fixture();
  await f.host.start();
  const p = parts("large", "x".repeat(64 * 1024 * 1024));
  f.budget.reserve(p.reservedBytes);
  expect(f.host.enqueue(p)).toBeUndefined();
  while (!f.sent.some((m) => m.type === "meta")) await tick();
  const slices = f.sent.filter((m) => m.type === "part");
  expect(slices).toHaveLength(64);
  expect(slices.every((m) => m.bytes.byteLength <= 1024 * 1024)).toBe(true);
  expect(f.yields()).toBeGreaterThanOrEqual(63);
  expect(f.budget.held()).toBe(128 * 1024 * 1024);
  for (const slice of slices)
    f.message({
      type: "slice-ack",
      requestId: "large",
      generation: 0,
      bytes: slice.bytes.byteLength,
    });
  expect(f.budget.held()).toBe(p.reservedBytes);
  f.message({
    type: "written",
    requestId: "large",
    generation: 0,
    at: 1000,
    relPath: "1970/01/01/large.json.enc",
    sizeBytes: 10,
    sha256: "digest",
    truncated: false,
    omitted: false,
  });
  await tick();
  expect(f.published).toEqual(["large"]);
  expect(f.budget.held()).toBe(0);
  f.host.stop();
});

test("crash fails requests, releases transferred reservations once, and fences old replies", async () => {
  const f = fixture();
  await f.host.start();
  const p = parts();
  f.budget.reserve(p.reservedBytes);
  f.host.enqueue(p);
  await tick();
  f.message({ type: "publishing", requestId: "req", generation: 0, relPath: "path" });
  expect(f.host.isPending("path")).toBe(true);
  f.exit();
  await tick();
  expect(f.failed).toEqual(["req"]);
  expect(f.dropped).toEqual(["writer_crash"]);
  expect(f.budget.held()).toBe(0);
  expect(f.host.isPending("path")).toBe(false);
  f.message({ type: "slice-ack", requestId: "req", generation: 0, bytes: 5 });
  expect(f.budget.held()).toBe(0);
  f.host.stop();
});

test("a refused publication path stays protected until worker cleanup", async () => {
  const budget = createCaptureBudget(100);
  let reply = (_m: WorkerMessage) => {};
  const host = createBodyWriterHost({
    spawn: () => ({
      post: () => {},
      onMessage: (fn) => {
        reply = fn;
      },
      onExit: () => {},
      terminate: () => {},
    }),
    bodies: { publish: async () => false, fail: async () => {} },
    budget,
    logger: noopLogger,
    now: Date.now,
    timers: { setTimeout, clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
  });
  await host.start();
  const p = parts();
  budget.reserve(p.reservedBytes);
  host.enqueue(p);
  await tick();
  reply({ type: "publishing", requestId: "req", generation: 0, relPath: "path" });
  reply({
    type: "written",
    requestId: "req",
    generation: 0,
    at: 1000,
    relPath: "path",
    sizeBytes: 1,
    sha256: "hash",
    truncated: false,
    omitted: false,
  });
  await tick();
  expect(host.isPending("path")).toBe(true);
  expect(budget.held()).toBeGreaterThan(0);
  reply({ type: "cleaned", requestId: "req", generation: 0 });
  expect(host.isPending("path")).toBe(false);
  expect(budget.held()).toBe(0);
  host.stop();
});
