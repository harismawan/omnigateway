import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { captureLogger } from "@omni/testkit";
import { createWorkerHost, type HostedWorker } from "../../src/workerHost/instance.ts";
import { fakeTimers, flush } from "../exportHost/fakes.ts";

type Input = { command: "hold" | "continue" | "finish" | "work" };
type Output = { event: "held" | "result" };

function fakeWorker(
  options: { ack?: boolean; stopExits?: boolean; terminateExits?: boolean } = {},
) {
  const messages: Array<(m: Output) => void> = [];
  const exits: Array<() => void> = [];
  const worker: HostedWorker<Input, Output> & {
    posted: Input[];
    terminated: boolean;
    alive: boolean;
    emit(m: Output): void;
    close(): void;
  } = {
    posted: [],
    terminated: false,
    alive: true,
    post(m) {
      worker.posted.push(m);
      if (m.command === "hold" && options.ack !== false) {
        queueMicrotask(() => worker.emit({ event: "held" }));
      }
      if (m.command === "finish" && options.stopExits !== false) {
        queueMicrotask(() => worker.close());
      }
    },
    onMessage: (listener) => messages.push(listener),
    onExit: (listener) => exits.push(listener),
    terminate() {
      worker.terminated = true;
      if (options.terminateExits !== false) worker.close();
    },
    emit(m) {
      for (const listener of messages) listener(m);
    },
    close() {
      if (!worker.alive) return;
      worker.alive = false;
      for (const listener of exits.splice(0)) listener();
    },
  };
  return worker;
}

function setup(options: Parameters<typeof fakeWorker>[0] = {}) {
  const clock = fakeTimers();
  const workers: ReturnType<typeof fakeWorker>[] = [];
  const received: Output[] = [];
  const box = { exits: 0, failSpawn: false, wanted: true, hold: null as Promise<void> | null };
  const logger = captureLogger();
  const host = createWorkerHost<Input, Output>({
    spawn() {
      if (box.failSpawn) throw new Error("secret path");
      const worker = fakeWorker(options);
      workers.push(worker);
      return worker;
    },
    lifecycle: {
      pause: { command: "hold" },
      resume: { command: "continue" },
      stop: { command: "finish" },
    },
    timers: clock,
    now: () => clock.now,
    logger,
    name: "test worker",
    onMessage: (m) => received.push(m),
    onExit: () => box.exits++,
    shouldStart: async () => {
      if (box.hold !== null) await box.hold;
      return box.wanted;
    },
  });
  const last = () => {
    const worker = workers.at(-1);
    if (worker === undefined) throw new Error("no worker");
    return worker;
  };
  const pause = () => host.pause((m) => m.event === "held");
  return { host, clock, workers, last, pause, box, received, logger };
}

test("typed messages reach only the current worker; retiring and stale messages are ignored", async () => {
  const s = setup();
  await s.host.start();
  s.host.post({ command: "work" });
  expect(s.last().posted).toEqual([{ command: "work" }]);
  s.last().emit({ event: "result" });
  expect(s.received).toEqual([{ event: "result" }]);
  const old = s.last();
  await s.host.idle();
  old.emit({ event: "result" });
  await flush();
  expect(s.received).toHaveLength(1);
  expect(s.box.exits).toBe(1);
  expect(() => s.host.post({ command: "work" })).toThrow("test worker not running");
});

test("restart backoff doubles to 60 seconds and a ten-minute life resets it", async () => {
  const s = setup();
  await s.host.start();
  const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
  for (const delay of delays) {
    await s.clock.advance(180_000);
    s.last().close();
    const before = s.workers.length;
    await s.clock.advance(delay - 1);
    expect(s.workers).toHaveLength(before);
    await s.clock.advance(1);
    expect(s.workers).toHaveLength(before + 1);
  }
  expect(s.host.restarts()).toBe(8);
  await s.clock.advance(600_000);
  s.last().close();
  await s.clock.advance(999);
  expect(s.workers).toHaveLength(9);
  await s.clock.advance(1);
  expect(s.workers).toHaveLength(10);
});

test("five deaths within ten minutes stay down until explicitly revived", async () => {
  const s = setup();
  await s.host.start();
  for (let i = 0; i < 5; i++) {
    s.last().close();
    await s.clock.advance(60_000);
  }
  expect(s.host.state()).toBe("down");
  await s.host.start();
  await s.clock.advance(600_000);
  expect(s.workers).toHaveLength(5);
  await s.host.revive();
  expect(s.workers).toHaveLength(6);
  s.last().close();
  await s.clock.advance(1_000);
  expect(s.workers).toHaveLength(7);
});

test("spawn failures count as deaths without exposing the thrown error", async () => {
  const s = setup();
  s.box.failSpawn = true;
  await s.host.start();
  expect(s.host.state()).toBe("restarting");
  expect(s.logger.lines.join("\n")).not.toContain("secret path");
  s.box.failSpawn = false;
  await s.clock.advance(1_000);
  expect(s.workers).toHaveLength(1);
  expect(s.host.restarts()).toBe(1);
});

test("pause suppresses a pending restart and a paused death waits until resume", async () => {
  const s = setup();
  await s.host.start();
  s.last().close();
  await s.pause();
  await s.clock.advance(60_000);
  expect(s.workers).toHaveLength(1);
  expect(s.host.restarts()).toBe(0);
  await s.host.resume(false);
  await s.pause();
  s.last().close();
  await s.clock.advance(60_000);
  expect(s.workers).toHaveLength(2);
  await s.host.resume(true);
  expect(s.workers).toHaveLength(3);
});

test("pause waits for its predicate, not any message; resume reuses the acked worker", async () => {
  const s = setup({ ack: false });
  await s.host.start();
  let done = false;
  const pausing = s.pause().then(() => {
    done = true;
  });
  await flush();
  s.last().emit({ event: "result" });
  await flush();
  expect(done).toBe(false);
  s.last().emit({ event: "held" });
  await pausing;
  expect(s.last().terminated).toBe(false);
  await s.host.resume(false);
  expect(s.last().posted).toEqual([{ command: "hold" }, { command: "continue" }]);
  expect(s.workers).toHaveLength(1);
});

test("terminate returning is not exit: pause waits for close after the five-second ack budget", async () => {
  const s = setup({ ack: false, terminateExits: false });
  await s.host.start();
  let done = false;
  const pausing = s.pause().then(() => {
    done = true;
  });
  await flush();
  await s.clock.advance(4_999);
  expect(s.last().terminated).toBe(false);
  await s.clock.advance(1);
  expect(s.last().terminated).toBe(true);
  expect(done).toBe(false);
  await s.clock.advance(4_999);
  expect(done).toBe(false);
  s.last().close();
  await pausing;
  await s.host.resume(true);
  expect(s.workers).toHaveLength(2);
  expect(s.host.restarts()).toBe(0);
});

test("refused pauses keep retiring threads tracked across recovery attempts; late close permits one start", async () => {
  const s = setup({ ack: false, stopExits: false, terminateExits: false });
  await s.host.start();
  const old = s.last();
  for (let i = 0; i < 3; i++) {
    const pausing = s.pause().catch((e: unknown) => e);
    await flush();
    await s.clock.advance(i === 0 ? 10_000 : 5_000);
    const error = await pausing;
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({
      code: "OVERLOADED",
      message: "test worker did not stop; nothing was restored",
    });
    await s.host.resume(false);
    expect(s.host.state()).toBe("stopping");
    expect(s.workers).toHaveLength(1);
  }
  old.close();
  await flush();
  expect(s.workers).toHaveLength(2);
  expect(s.workers.filter((w) => w.alive)).toHaveLength(1);
});

test("idle workers are tracked and drained; no start beside a stopping thread", async () => {
  const s = setup({ stopExits: false, terminateExits: false });
  await s.host.start();
  const old = s.last();
  await s.host.idle();
  await s.host.start();
  expect(s.host.state()).toBe("stopping");
  expect(s.workers).toHaveLength(1);
  let done = false;
  const pausing = s.pause().then(() => {
    done = true;
  });
  await flush();
  expect(old.terminated).toBe(true);
  expect(done).toBe(false);
  old.close();
  await pausing;
  expect(s.workers).toHaveLength(1);
  s.box.wanted = false;
  await s.host.resume(true);
  expect(s.host.state()).toBe("idle");
});

test("unsafe halt survives a failed recovery and only a successful swap clears it", async () => {
  const s = setup();
  await s.host.start();
  await s.pause();
  await s.host.halt();
  await s.pause();
  await s.host.resume(false);
  await s.host.start();
  await s.host.revive();
  await s.clock.advance(600_000);
  expect(s.host.state()).toBe("halted");
  expect(s.workers).toHaveLength(1);
  await s.pause();
  await s.host.resume(true);
  expect(s.host.state()).toBe("running");
  expect(s.workers).toHaveLength(2);
});

test("lifecycle calls serialize: resume cannot pass an outstanding pause", async () => {
  const s = setup({ ack: false });
  await s.host.start();
  const pausing = s.pause();
  const resuming = s.host.resume(true);
  await flush();
  expect(s.last().posted).toEqual([{ command: "hold" }]);
  s.last().emit({ event: "held" });
  await Promise.all([pausing, resuming]);
  expect(s.last().posted).toEqual([{ command: "hold" }, { command: "continue" }]);
});

test("stop drains for five seconds before terminating a worker that did not exit", async () => {
  const s = setup({ stopExits: false });
  await s.host.start();
  s.host.stop();
  await s.clock.advance(4_999);
  expect(s.last().terminated).toBe(false);
  await s.clock.advance(1);
  expect(s.last().terminated).toBe(true);
  expect(s.clock.pending()).toBe(0);
});

test("stop is final even across pending pause/resume, restart and start-policy reads", async () => {
  const s = setup({ ack: false, stopExits: false });
  await s.host.start();
  const pausing = s.pause();
  const resuming = s.host.resume(true);
  await flush();
  s.host.stop();
  await Promise.all([pausing, resuming]);
  // The outstanding pause drains retiring threads immediately; shutdown alone
  // gets its five-second graceful budget (covered separately above).
  expect(s.last().terminated).toBe(true);
  await s.host.start();
  await s.host.revive();
  await s.host.halt();
  await s.clock.advance(600_000);
  expect(s.host.state()).toBe("stopped");
  expect(s.workers).toHaveLength(1);
  expect(s.clock.pending()).toBe(0);

  const t = setup();
  await t.pause();
  const gate = Promise.withResolvers<void>();
  t.box.hold = gate.promise;
  const starting = t.host.resume(true);
  await flush();
  t.host.stop();
  gate.resolve();
  await starting;
  expect(t.workers).toHaveLength(0);
  expect(t.clock.pending()).toBe(0);

  const r = setup();
  await r.host.start();
  r.last().close();
  r.host.stop();
  await r.clock.advance(600_000);
  expect(r.workers).toHaveLength(1);
  expect(r.clock.pending()).toBe(0);
});
