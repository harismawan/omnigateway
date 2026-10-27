import { expect, test } from "bun:test";
import { noopLogger } from "@omni/ir";
import { createCaptureBudget } from "../../src/bodies/budget.ts";
import { createBodyWriterHost } from "../../src/bodies/host.ts";
import type { MainMessage, WorkerMessage } from "../../src/bodies/protocol.ts";
import type { CapturedParts } from "../../src/bodyCapture.ts";
import type { Timers } from "../../src/workerHost/instance.ts";
import { fakeTimers } from "../exportHost/fakes.ts";

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

test("reader death rejects its single pending reply without skipping capture cleanup", async () => {
  const f = fixture();
  await f.host.start();
  const reading = f.host.read("read");
  const rejected = reading.catch((error: unknown) => error);
  await expect(f.host.read("overflow")).rejects.toThrow("unavailable");
  const p = parts("captured");
  f.budget.reserve(p.reservedBytes);
  f.host.enqueue(p);
  f.exit();
  expect(await rejected).toMatchObject({ message: "body reader unavailable" });
  expect(f.budget.held()).toBe(0);
  expect(f.dropped).toEqual(["writer_crash"]);
  f.host.stop();
});

test("reader lifetime cancels a stalled raw client and bounds admission to one slot", async () => {
  const clock = fakeTimers();
  const f = fixture(undefined, clock);
  await f.host.start();
  const opening = f.host.readRaw("req", "client.request");
  const message = f.sent.at(-1);
  if (message?.type !== "readRaw") throw new Error("no read request");
  f.message({ type: "raw-ready", ref: message.ref, found: true });
  const stream = await opening;
  if (!stream) throw new Error("no stream");
  expect(f.sent.some((m) => m.type === "read-pull")).toBe(false);
  const consuming = stream.getReader();
  const pending = Array.from({ length: 10 }, () => consuming.read().catch(() => undefined));
  await tick();
  expect(f.sent.filter((m) => m.type === "read-pull")).toHaveLength(1);
  await expect(f.host.read("overflow")).rejects.toThrow("unavailable");
  await clock.advance(30_000);
  expect(f.sent.at(-1)).toEqual({ type: "read-cancel", ref: message.ref });
  await Promise.all(pending);
  await expect(consuming.read()).rejects.toThrow("unavailable");
  f.host.stop();
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

function fixture(fail?: () => Promise<void>, timers?: Timers, publish?: () => Promise<boolean>) {
  const budget = createCaptureBudget(256 * 1024 * 1024);
  const sent: MainMessage[] = [];
  let message = (_m: WorkerMessage) => {};
  const exits: Array<() => void> = [];
  let terminated = 0;
  let spawned = 0;
  const failed: string[] = [];
  const published: string[] = [];
  const dropped: string[] = [];
  let yields = 0;
  const host = createBodyWriterHost({
    spawn: () => {
      spawned++;
      return {
        post: (m) => sent.push(m),
        onMessage: (fn) => {
          message = fn;
        },
        onExit: (fn) => {
          exits.push(fn);
        },
        terminate: () => {
          terminated++;
        },
      };
    },
    bodies: {
      publish: async (r) => {
        published.push(r.requestId);
        return publish === undefined ? true : publish();
      },
      fail: async (id) => {
        failed.push(id);
        await fail?.();
      },
    },
    budget,
    logger: noopLogger,
    now: Date.now,
    timers: timers ?? {
      setTimeout,
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
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
    exit: () => {
      for (const exit of [...exits]) exit();
    },
    terminated: () => terminated,
    spawned: () => spawned,
    yields: () => yields,
  };
}

test("restore drops queued captures and fences both stale ACKs and late old captures", async () => {
  const f = fixture();
  await f.host.start();
  const oldGeneration = f.host.generation();
  for (const id of ["old", "queued"]) {
    const p = parts(id);
    f.budget.reserve(p.reservedBytes);
    f.host.enqueue(p, oldGeneration);
  }
  const paused = f.host.pause();
  await tick();
  f.message({ type: "paused" });
  await paused;
  expect(f.dropped).toEqual(["restore", "restore"]);
  expect(f.failed).toEqual(["old", "queued"]);
  await f.host.resume(true);
  expect(f.host.generation()).toBe(oldGeneration + 1);
  const reused = parts("old");
  f.budget.reserve(reused.reservedBytes);
  f.host.enqueue(reused);
  const late = parts("arrived_after_swap");
  f.budget.reserve(late.reservedBytes);
  f.host.enqueue(late, oldGeneration);
  f.message({
    type: "written",
    requestId: "old",
    generation: oldGeneration,
    at: 1000,
    relPath: "old-path",
    sizeBytes: 1,
    sha256: "old",
    truncated: false,
    omitted: false,
  });
  await tick();
  expect(f.published).toEqual([]);
  expect(f.sent.some((m) => "requestId" in m && m.requestId === "arrived_after_swap")).toBe(false);
  expect(f.failed).not.toContain("arrived_after_swap"); // Never mutate a restored row with this id.
  expect(f.dropped).toEqual(["restore", "restore", "restore"]);
  f.host.stop();
  expect(f.budget.held()).toBe(0);
});

function clock() {
  const scheduled = new Map<object, { fn: () => void; ms: number }>();
  return {
    timers: {
      setTimeout(fn: () => void, ms: number) {
        const key = {};
        scheduled.set(key, { fn, ms });
        return key;
      },
      clearTimeout(key: unknown) {
        scheduled.delete(key as object);
      },
    },
    fire(ms: number) {
      const item = [...scheduled].find(([, value]) => value.ms === ms);
      if (item === undefined) throw new Error(`no ${ms} ms timer`);
      scheduled.delete(item[0]);
      item[1].fn();
    },
  };
}

test("pause timeout terminates, refuses without actual close, and never reopens beside that thread", async () => {
  const c = clock();
  const f = fixture(undefined, c.timers);
  await f.host.start();
  const pausing = f.host.pause();
  const refused = pausing.catch((error: unknown) => error);
  await tick();
  c.fire(5000);
  await tick();
  expect(f.terminated()).toBe(1);
  c.fire(5000);
  expect(await refused).toMatchObject({ message: expect.stringContaining("nothing was restored") });
  await f.host.resume(false);
  expect(f.spawned()).toBe(1);
  f.exit();
  await tick();
  expect(f.spawned()).toBe(2);
  f.host.stop();
});

test("restore starts pause immediately and retries cannot bypass a timed-out database barrier", async () => {
  const c = clock();
  const blocked = Promise.withResolvers<void>();
  const f = fixture(() => blocked.promise, c.timers);
  await f.host.start();
  for (const id of ["first", "must_not_run_late"]) {
    const p = parts(id);
    f.budget.reserve(p.reservedBytes);
    f.host.enqueue(p);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const paused = f.host.pause().catch((e: unknown) => e);
    await tick();
    expect(f.sent.some((m) => m.type === "pause")).toBe(true);
    f.message({ type: "paused" });
    c.fire(5000);
    expect(await paused).toMatchObject({ message: expect.stringContaining("database") });
    await f.host.resume(false);
  }
  expect(f.failed).toEqual(["first"]);
  blocked.resolve();
  await tick();
  expect(f.failed).toEqual(["first"]); // Timed-out sweep cannot continue later.
  const recovered = f.host.pause();
  await tick();
  f.message({ type: "paused" });
  await recovered;
  await f.host.resume(true);
  expect(f.host.generation()).toBe(1);
  f.host.stop();
});

test("a publication barrier stays bounded across repeated refused restores", async () => {
  const c = clock();
  const blocked = Promise.withResolvers<boolean>();
  const f = fixture(undefined, c.timers, () => blocked.promise);
  await f.host.start();
  const p = parts();
  f.budget.reserve(p.reservedBytes);
  f.host.enqueue(p);
  await tick();
  f.message({
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
  for (let attempt = 0; attempt < 3; attempt++) {
    const paused = f.host.pause().catch((error: unknown) => error);
    await tick();
    f.message({ type: "paused" });
    c.fire(5000);
    expect(await paused).toMatchObject({ message: expect.stringContaining("database") });
    await f.host.resume(false);
  }
  blocked.reject(new Error("late old failure"));
  await tick();
  expect(f.failed).toEqual([]); // Retired publication cannot schedule new DB work.
  const paused = f.host.pause();
  await tick();
  f.message({ type: "paused" });
  await paused;
  await f.host.resume(true);
  f.host.stop();
});

for (const quiescence of ["ack", "close"] as const) {
  test(`rejection during pause includes its blocked failure write through ${quiescence} and retries`, async () => {
    const c = clock();
    const publication = Promise.withResolvers<boolean>();
    const failure = Promise.withResolvers<void>();
    const f = fixture(
      () => failure.promise,
      c.timers,
      () => publication.promise,
    );
    await f.host.start();
    const p = parts();
    f.budget.reserve(p.reservedBytes);
    f.host.enqueue(p);
    await tick();
    f.message({
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
    let outcome = "pending";
    const pausing = f.host.pause().then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "refused";
      },
    );
    await tick();
    publication.reject(new Error("publication rejected during pause"));
    await tick();
    expect(f.failed).toEqual(["req"]);
    if (quiescence === "ack") f.message({ type: "paused" });
    else f.exit();
    await tick();
    expect(outcome).toBe("pending");
    c.fire(5000);
    await pausing;
    expect(outcome).toBe("refused");
    await f.host.resume(false);
    const retry = f.host.pause().catch((error: unknown) => error);
    await tick();
    f.message({ type: "paused" });
    c.fire(5000);
    expect(await retry).toMatchObject({ message: expect.stringContaining("database") });
    expect(f.host.generation()).toBe(0);
    failure.resolve();
    await tick();
    const recovered = f.host.pause();
    await tick();
    f.message({ type: "paused" });
    await recovered;
    await f.host.resume(true);
    expect(f.host.generation()).toBe(1);
    expect(f.failed).toEqual(["req"]);
    f.host.stop();
  });
}

test("publication rejection retires recoverably and replacement waits for actual close", async () => {
  const c = clock();
  let first = true;
  const f = fixture(undefined, c.timers, async () => {
    if (first) {
      first = false;
      throw new Error("reply lost");
    }
    return true;
  });
  await f.host.start();
  const p = parts();
  f.budget.reserve(p.reservedBytes);
  f.host.enqueue(p);
  await tick();
  const written = {
    type: "written",
    requestId: "req",
    generation: 0,
    at: 1000,
    relPath: "path",
    sizeBytes: 1,
    sha256: "hash",
    truncated: false,
    omitted: false,
  } as const;
  f.message({ type: "publishing", requestId: "req", generation: 0, relPath: "path" });
  f.message(written);
  await tick();
  expect(f.host.isPending("path")).toBe(true);
  expect(f.spawned()).toBe(1);
  f.exit();
  await tick();
  c.fire(1000);
  await tick();
  expect(f.spawned()).toBe(2);
  expect(f.host.isPending("path")).toBe(false);
  const next = parts("next");
  f.budget.reserve(next.reservedBytes);
  f.host.enqueue(next);
  await tick();
  f.message({ ...written, requestId: "next" });
  await tick();
  expect(f.published).toEqual(["req", "next"]);
  expect(f.budget.held()).toBe(0);
  f.host.stop();
});

test("shutdown gives unwritten entries five seconds then counts and terminates them", async () => {
  const c = clock();
  const f = fixture(undefined, c.timers);
  await f.host.start();
  for (const id of ["one", "two"]) {
    const p = parts(id);
    f.budget.reserve(p.reservedBytes);
    f.host.enqueue(p);
  }
  const draining = f.host.drain();
  await tick();
  expect(f.dropped).toEqual([]);
  expect(f.terminated()).toBe(0);
  c.fire(5000);
  await draining;
  expect(f.dropped).toEqual(["writer_crash", "writer_crash"]);
  expect(f.terminated()).toBe(1);
  expect(f.budget.held()).toBe(0);
});

for (const blockedFailure of [false, true])
  test(`late recovery cannot extend drain for a retired live owner (${blockedFailure ? "deadline" : "early completion"})`, async () => {
    const c = fakeTimers();
    const publication = Promise.withResolvers<boolean>();
    const failure = Promise.withResolvers<void>();
    const f = fixture(
      blockedFailure ? () => failure.promise : undefined,
      c,
      () => publication.promise,
    );
    await f.host.start();
    const p = parts();
    f.budget.reserve(p.reservedBytes);
    f.host.enqueue(p);
    await tick();
    f.message({ type: "publishing", requestId: "req", generation: 0, relPath: "path" });
    f.message({
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
    let done = false;
    const draining = f.host.drain().then(() => {
      done = true;
    });
    await c.advance(4900);
    publication.reject(new Error("reply lost near deadline"));
    await tick();
    expect(f.sent.at(-1)?.type).toBe("stop");
    if (blockedFailure) {
      expect(f.terminated()).toBe(0);
      expect(done).toBe(false);
      await c.advance(99);
      expect(f.terminated()).toBe(0);
      await c.advance(1);
    }
    await draining;
    expect(f.terminated()).toBe(1);
    expect(f.host.isPending("path")).toBe(true); // terminate is not actual close.
    f.exit();
    expect(f.host.isPending("path")).toBe(false);
    failure.resolve();
    await c.advance(60000);
    expect(f.spawned()).toBe(1);
    expect(c.pending()).toBe(0);
  });

test("shutdown drains admitted writes and waits for main publication before returning", async () => {
  const f = fixture();
  await f.host.start();
  const p = parts();
  f.budget.reserve(p.reservedBytes);
  f.host.enqueue(p);
  let done = false;
  const draining = f.host.drain().then(() => {
    done = true;
  });
  await tick();
  expect(done).toBe(false);
  expect(f.sent.some((m) => m.type === "stop")).toBe(false);
  f.message({
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
  await draining;
  expect(f.published).toEqual(["req"]);
  expect(f.dropped).toEqual([]);
  expect(f.budget.held()).toBe(0);
  expect(f.sent.at(-1)?.type).toBe("stop");
});

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
