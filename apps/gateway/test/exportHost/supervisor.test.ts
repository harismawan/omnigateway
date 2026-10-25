import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { captureLogger } from "@omni/testkit";
import type { MainMessage, WorkerInit, WorkerMessage } from "../../src/export/protocol.ts";
import { createExportMetrics } from "../../src/exportHost/metrics.ts";
import {
  createExportSupervisor,
  DOWN_RECHECK_MS,
  IDLE_RECHECK_MS,
  PAUSE_ACK_MS,
  REQUEST_TIMEOUT_MS,
  RESTART_GIVE_UP,
  STOP_TERMINATE_MS,
  TERMINATE_WAIT_MS,
} from "../../src/exportHost/supervisor.ts";
import { createMetricRegistry } from "../../src/telemetry/registry.ts";
import { type FakeWorker, fakeTimers, fakeWorker, flush, status } from "./fakes.ts";

/**
 * The main thread's half of the export worker: when it runs, how it is
 * restarted, how a restore pauses it, and how a request that never gets an
 * answer still ends. Design: *Asynchrony* (start conditions), *Failure
 * isolation*, *Restore and import*, *Delivery* → Shutdown.
 */

const INIT: WorkerInit = {
  databasePath: "/tmp/none.db",
  databaseUrl: null,
  encryptionKey: "k".repeat(32),
  redisUrl: null,
  nodeId: "node-a",
  logLevel: "info",
  exportBodiesAllowed: false,
  gates: { bodyLoggingAllowed: false },
};

function setup(opts: { destinations?: number; worker?: () => FakeWorker } = {}) {
  const clock = fakeTimers();
  const workers: FakeWorker[] = [];
  /** `revision` stands for the store's destination rows: it changes on any edit. */
  const box = {
    destinations: opts.destinations ?? 1,
    revision: "r0",
    hold: null as Promise<void> | null,
    reads: 0,
  };
  const logger = captureLogger();
  const registry = createMetricRegistry({ maxSeries: 100, now: () => clock.now });
  let changes = 0;
  const supervisor = createExportSupervisor({
    init: INIT,
    spawn: (init) => {
      expect(init).toEqual(INIT);
      const w = (opts.worker ?? (() => fakeWorker()))();
      workers.push(w);
      return w;
    },
    readDestinations: async () => {
      box.reads += 1;
      if (box.hold !== null) await box.hold;
      return { count: box.destinations, revision: `${box.destinations}:${box.revision}` };
    },
    timers: clock,
    now: () => clock.now,
    logger,
    metrics: createExportMetrics(registry),
    onChange: () => {
      changes += 1;
    },
  });
  const last = (): FakeWorker => {
    const w = workers.at(-1);
    if (w === undefined) throw new Error("no worker spawned");
    return w;
  };
  return { clock, workers, box, logger, registry, supervisor, last, changes: () => changes };
}

const types = (w: FakeWorker): MainMessage["type"][] => w.posted.map((m) => m.type);

test("starts only when a destination exists", async () => {
  const none = setup({ destinations: 0 });
  await none.supervisor.start();
  expect(none.workers).toHaveLength(0);
  expect(none.supervisor.state()).toBe("idle");

  const one = setup();
  await one.supervisor.start();
  expect(one.workers).toHaveLength(1);
  expect(one.supervisor.state()).toBe("running");
});

test("the first destination's creation starts it; later changes wake it", async () => {
  const s = setup({ destinations: 0 });
  await s.supervisor.start();
  s.box.destinations = 1;
  await s.supervisor.destinationsChanged();
  expect(s.workers).toHaveLength(1);
  // A freshly spawned worker reads configuration itself; no message needed.
  expect(types(s.last())).toEqual([]);
  s.box.destinations = 2;
  await s.supervisor.destinationsChanged();
  expect(types(s.last())).toEqual(["destinationsChanged"]);
});

test("while idle it rechecks the store, so a destination made by another process starts it", async () => {
  const s = setup({ destinations: 0 });
  await s.supervisor.start();
  await s.clock.advance(IDLE_RECHECK_MS);
  expect(s.workers).toHaveLength(0);
  // `omni export add`, or another cluster node, wrote it: nothing told this process.
  s.box.destinations = 1;
  await s.clock.advance(IDLE_RECHECK_MS);
  expect(s.workers).toHaveLength(1);
  expect(s.supervisor.state()).toBe("running");
  s.supervisor.stop();
  expect(s.clock.pending()).toBe(1); // only the stop's terminate timer
});

test("removing the last destination stops the worker, and its exit is not a death", async () => {
  const s = setup();
  await s.supervisor.start();
  s.box.destinations = 0;
  await s.supervisor.destinationsChanged();
  await flush();
  expect(types(s.workers[0] as FakeWorker)).toEqual(["stop"]);
  expect(s.supervisor.state()).toBe("idle");
  await s.clock.advance(120_000);
  expect(s.workers).toHaveLength(1);
  expect(s.supervisor.restarts()).toBe(0);
});

test("a dead worker is restarted with backoff 1 s doubling, and counted", async () => {
  const s = setup();
  await s.supervisor.start();
  s.last().die();
  await flush();
  expect(s.supervisor.state()).toBe("restarting");
  await s.clock.advance(999);
  expect(s.workers).toHaveLength(1);
  await s.clock.advance(1);
  expect(s.workers).toHaveLength(2);
  expect(s.supervisor.restarts()).toBe(1);
  expect(s.registry.value("omni_export_worker_restarts_total", {})).toBe(1);

  s.last().die();
  await flush();
  await s.clock.advance(1_999);
  expect(s.workers).toHaveLength(2);
  await s.clock.advance(1);
  expect(s.workers).toHaveLength(3);
});

test("the backoff caps at 60 s, and resets once a worker has lived ten minutes", async () => {
  const s = setup();
  await s.supervisor.start();
  // Each worker lives three minutes: never five deaths in ten minutes, but consecutive.
  const delays: number[] = [];
  const dieAndWait = async (): Promise<number> => {
    s.last().die();
    await flush();
    const before = s.workers.length;
    let waited = 0;
    while (s.workers.length === before) {
      await s.clock.advance(1_000);
      waited += 1_000;
    }
    return waited;
  };
  for (let i = 0; i < 8; i++) {
    await s.clock.advance(180_000);
    delays.push(await dieAndWait());
  }
  expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  expect(s.supervisor.state()).toBe("running");

  // A worker that outlives the window was healthy: the next death starts over.
  await s.clock.advance(600_000);
  expect(await dieAndWait()).toBe(1_000);
});

test("five deaths in ten minutes stays down until the next destination change", async () => {
  const s = setup();
  await s.supervisor.start();
  for (let i = 0; i < RESTART_GIVE_UP; i++) {
    s.last().die();
    await flush();
    if (i < RESTART_GIVE_UP - 1) await s.clock.advance(60_000);
  }
  expect(s.supervisor.state()).toBe("down");
  const spawned = s.workers.length;
  await s.clock.advance(600_000);
  expect(s.workers).toHaveLength(spawned);
  expect(s.logger.lines.some((l) => l.includes("export worker stopped restarting"))).toBe(true);

  await s.supervisor.destinationsChanged();
  expect(s.workers).toHaveLength(spawned + 1);
  expect(s.supervisor.state()).toBe("running");
});

test("requests reach the worker and resolve with its reply", async () => {
  const s = setup({
    worker: () =>
      fakeWorker({
        onPost: (w, m) => {
          if (m.type === "test") {
            queueMicrotask(() =>
              w.emit({ type: "testResult", ref: m.ref, ok: true, status: 200, latencyMs: 3 }),
            );
          }
        },
      }),
  });
  await s.supervisor.start();
  const reply = await s.supervisor.request({ type: "test", id: "hook" });
  expect(reply).toMatchObject({ type: "testResult", ok: true, status: 200 });
});

test("with no worker running, requests refuse at once with 503 export worker not running", async () => {
  const s = setup({ destinations: 0 });
  await s.supervisor.start();
  const refused = await s.supervisor.request({ type: "skip", id: "hook" }).catch((e) => e);
  expect(refused).toBeInstanceOf(GatewayError);
  expect((refused as GatewayError).code).toBe("OVERLOADED");
  expect((refused as GatewayError).message).toBe("export worker not running");
});

test("a worker that dies with a request pending answers it with the fixed error", async () => {
  const s = setup();
  await s.supervisor.start();
  const pending = s.supervisor.request({ type: "preview", requestId: "req_1" }).catch((e) => e);
  await flush();
  s.last().die();
  const error = (await pending) as GatewayError;
  expect(error.code).toBe("OVERLOADED");
  expect(error.message).toBe("export worker not running");
});

test("a request with no reply times out: 30 s for test, 10 s for the others", async () => {
  const s = setup();
  await s.supervisor.start();
  expect(REQUEST_TIMEOUT_MS).toEqual({
    test: 30_000,
    preview: 10_000,
    skip: 10_000,
    ackGap: 10_000,
  });
  let settled = false;
  const test30 = s.supervisor.request({ type: "test", id: "hook" }).catch((e) => {
    settled = true;
    return e;
  });
  const skip10 = s.supervisor.request({ type: "skip", id: "hook" }).catch((e) => e);
  await s.clock.advance(10_000);
  expect(((await skip10) as GatewayError).code).toBe("TIMEOUT");
  expect(settled).toBe(false);
  await s.clock.advance(20_000);
  const error = (await test30) as GatewayError;
  expect(error.code).toBe("TIMEOUT");
  expect(error.message).toBe("export worker did not reply in time");
  // A late reply for a request already answered is ignored.
  s.last().emit({ type: "skipResult", ref: "1", ok: true, at: 1 });
  expect(s.clock.pending()).toBe(0);
});

test("restore: pause waits for paused, suppresses restarts, and resume continues the same worker", async () => {
  const s = setup();
  await s.supervisor.start();
  await s.supervisor.pause();
  expect(types(s.last())).toEqual(["pause"]);
  expect(s.supervisor.state()).toBe("paused");

  // Requests are refused while paused.
  const refused = (await s.supervisor
    .request({ type: "skip", id: "x" })
    .catch((e) => e)) as GatewayError;
  expect(refused.message).toBe("export worker not running");

  await s.supervisor.resume(true);
  expect(types(s.last())).toEqual(["pause", "resume"]);
  expect(s.workers).toHaveLength(1);
  expect(s.supervisor.state()).toBe("running");
});

test("restore: a worker that never acks pause is terminated at 5 s, and resume starts a fresh one", async () => {
  const s = setup({ worker: () => fakeWorker({ ackPause: false }) });
  await s.supervisor.start();
  const pausing = s.supervisor.pause();
  await flush();
  await s.clock.advance(PAUSE_ACK_MS - 1);
  expect(s.last().terminated).toBe(false);
  await s.clock.advance(1);
  await pausing;
  expect(s.workers[0]?.terminated).toBe(true);
  // A terminated-for-restore worker is not a death: nothing restarts it.
  await s.clock.advance(120_000);
  expect(s.workers).toHaveLength(1);
  expect(s.supervisor.restarts()).toBe(0);

  await s.supervisor.resume(true);
  expect(s.workers).toHaveLength(2);
  expect(s.supervisor.state()).toBe("running");
});

test("restore: a worker dying while paused is not restarted until resume", async () => {
  const s = setup();
  await s.supervisor.start();
  await s.supervisor.pause();
  s.last().die();
  await s.clock.advance(120_000);
  expect(s.workers).toHaveLength(1);
  await s.supervisor.resume(true);
  expect(s.workers).toHaveLength(2);
});

test("restore: resume starts a worker when the restored database has destinations and none ran", async () => {
  const s = setup({ destinations: 0 });
  await s.supervisor.start();
  await s.supervisor.pause();
  s.box.destinations = 2;
  await s.supervisor.resume(true);
  expect(s.workers).toHaveLength(1);
});

test("restore: a destination change during the pause waits for resume", async () => {
  const s = setup({ destinations: 0 });
  await s.supervisor.start();
  await s.supervisor.pause();
  s.box.destinations = 1;
  await s.supervisor.destinationsChanged();
  expect(s.workers).toHaveLength(0);
  await s.supervisor.resume(true);
  expect(s.workers).toHaveLength(1);
});

test("a failed swap halts export: no restart, no destination-change start, until a resume", async () => {
  const s = setup();
  await s.supervisor.start();
  await s.supervisor.pause();
  await s.supervisor.halt();
  expect(s.supervisor.state()).toBe("halted");
  expect(s.workers[0]?.alive).toBe(false);
  await s.supervisor.destinationsChanged();
  await s.clock.advance(120_000);
  expect(s.workers).toHaveLength(1);
  // The documented recovery — a restore that succeeds — resumes it.
  await s.supervisor.pause();
  await s.supervisor.resume(true);
  expect(s.workers).toHaveLength(2);
});

test("stop posts stop, terminates after the budget, and nothing restarts", async () => {
  const s = setup({
    worker: () =>
      fakeWorker({
        onPost: () => {
          // Never exits on its own.
        },
      }),
  });
  await s.supervisor.start();
  // Override the fake's auto-exit on stop.
  const w = s.last();
  w.post = (m) => {
    w.posted.push(m);
  };
  s.supervisor.stop();
  expect(types(w)).toEqual(["stop"]);
  expect(w.terminated).toBe(false);
  await s.clock.advance(STOP_TERMINATE_MS);
  expect(w.terminated).toBe(true);
  await s.clock.advance(120_000);
  expect(s.workers).toHaveLength(1);
  expect(s.supervisor.state()).toBe("stopped");
});

test("status is kept, folded into metrics, and announced only when it changes materially", async () => {
  const s = setup();
  await s.supervisor.start();
  const base = s.changes();
  const emit = (m: WorkerMessage) => s.last().emit(m);
  emit({
    type: "status",
    at: 1,
    destinations: [status({ counters: { ...status().counters, recordsSent: 2 } })],
  });
  expect(s.supervisor.statuses()).toHaveLength(1);
  expect(
    s.registry.value("omni_export_records_total", { destination: "hook", outcome: "sent" }),
  ).toBe(2);
  expect(s.changes()).toBe(base + 1);
  // Only lag and counters moved: not material.
  emit({
    type: "status",
    at: 2,
    destinations: [status({ lagMs: 12_000, counters: { ...status().counters, recordsSent: 3 } })],
  });
  expect(s.changes()).toBe(base + 1);
  emit({
    type: "status",
    at: 3,
    destinations: [status({ lastError: "HTTP 500", lastErrorAt: 3 })],
  });
  expect(s.changes()).toBe(base + 2);

  // A restart resets the metrics baseline: the new instance's 1 adds 1.
  s.last().die();
  await flush();
  await s.clock.advance(1_000);
  s.last().emit({
    type: "status",
    at: 4,
    destinations: [status({ counters: { ...status().counters, recordsSent: 1 } })],
  });
  expect(
    s.registry.value("omni_export_records_total", { destination: "hook", outcome: "sent" }),
  ).toBe(4);
});

test("a spawn that throws is a death like any other: logged, backed off, retried", async () => {
  let fail = true;
  const s = setup({
    worker: () => {
      if (fail) throw new Error("no such file: worker.ts");
      return fakeWorker();
    },
  });
  await s.supervisor.start();
  expect(s.supervisor.state()).toBe("restarting");
  expect(s.logger.lines.some((l) => l.includes("export worker could not be started"))).toBe(true);
  // The path in the error never reaches stdout.
  expect(s.logger.lines.some((l) => l.includes("worker.ts"))).toBe(false);
  fail = false;
  await s.clock.advance(1_000);
  expect(s.supervisor.state()).toBe("running");
});

// --- review round 1 ---------------------------------------------------------

test("pause waits for a terminated worker to actually exit before it lets a swap go", async () => {
  const s = setup({ worker: () => fakeWorker({ ackPause: false, terminateExits: false }) });
  await s.supervisor.start();
  let paused = false;
  const pausing = s.supervisor.pause().then(() => {
    paused = true;
  });
  await flush();
  await s.clock.advance(PAUSE_ACK_MS);
  // Terminated, but the thread is still running (a native call in flight).
  expect(s.last().terminated).toBe(true);
  expect(paused).toBe(false);
  await s.clock.advance(1_000);
  expect(paused).toBe(false);
  s.last().die();
  await pausing;
  expect(paused).toBe(true);
});

test("a worker that never exits after terminate refuses the swap with a fixed error", async () => {
  const s = setup({ worker: () => fakeWorker({ ackPause: false, terminateExits: false }) });
  await s.supervisor.start();
  const pausing = s.supervisor.pause().catch((e) => e);
  await flush();
  await s.clock.advance(PAUSE_ACK_MS + TERMINATE_WAIT_MS);
  const error = (await pausing) as GatewayError;
  expect(error).toBeInstanceOf(GatewayError);
  expect(error.code).toBe("OVERLOADED");
  expect(error.message).toBe("export worker did not stop; nothing was restored");
});

test("restore right after the last destination's removal waits for the stopping worker", async () => {
  const s = setup({ worker: () => fakeWorker({ exitOnStop: false, terminateExits: false }) });
  await s.supervisor.start();
  const w = s.last();
  s.box.destinations = 0;
  await s.supervisor.destinationsChanged();
  expect(types(w)).toEqual(["stop"]);
  expect(w.alive).toBe(true);

  let paused = false;
  const pausing = s.supervisor.pause().then(() => {
    paused = true;
  });
  await flush();
  // A worker still stopping holds its handles: terminated now, and waited for.
  expect(w.terminated).toBe(true);
  expect(paused).toBe(false);
  w.die();
  await pausing;
  expect(paused).toBe(true);
});

test("an error notification is not an exit: only the worker's exit counts as gone", async () => {
  const s = setup({ worker: () => fakeWorker({ terminateExits: false }) });
  await s.supervisor.start();
  // A worker whose `close` has not come is still the current one.
  s.last().terminate();
  await flush();
  expect(s.supervisor.state()).toBe("running");
  s.last().die();
  await flush();
  expect(s.supervisor.state()).toBe("restarting");
});

test("a failed swap stays halted through a later restore that fails before swapping", async () => {
  const s = setup();
  await s.supervisor.start();
  await s.supervisor.pause();
  await s.supervisor.halt();
  // The operator tries another restore; it is refused before the swap began.
  await s.supervisor.pause();
  await s.supervisor.resume(false);
  expect(s.supervisor.state()).toBe("halted");
  expect(s.workers).toHaveLength(1);
  await s.clock.advance(120_000);
  expect(s.workers).toHaveLength(1);
  // A restore that does swap clears it.
  await s.supervisor.pause();
  await s.supervisor.resume(true);
  expect(s.supervisor.state()).toBe("running");
  expect(s.workers).toHaveLength(2);
});

test("stop invalidates lifecycle work in flight: a held read cannot spawn or re-arm polling", async () => {
  const s = setup();
  const gate = Promise.withResolvers<void>();
  s.box.hold = gate.promise;
  const starting = s.supervisor.start();
  await flush();
  s.supervisor.stop();
  gate.resolve();
  await starting;
  expect(s.workers).toHaveLength(0);
  expect(s.supervisor.state()).toBe("stopped");
  expect(s.clock.pending()).toBe(0);

  // The same through a destination change, and through an empty answer.
  const t = setup({ destinations: 0 });
  await t.supervisor.start();
  const held = Promise.withResolvers<void>();
  t.box.hold = held.promise;
  t.box.destinations = 1;
  const changing = t.supervisor.destinationsChanged();
  await flush();
  t.supervisor.stop();
  held.resolve();
  await changing;
  expect(t.workers).toHaveLength(0);
  expect(t.supervisor.state()).toBe("stopped");
  expect(t.clock.pending()).toBe(0);
});

test("while down it polls the destinations and revives only on a real change", async () => {
  const s = setup();
  await s.supervisor.start();
  for (let i = 0; i < RESTART_GIVE_UP; i++) {
    s.last().die();
    await flush();
    if (i < RESTART_GIVE_UP - 1) await s.clock.advance(60_000);
  }
  expect(s.supervisor.state()).toBe("down");
  const spawned = s.workers.length;
  const reads = s.box.reads;

  // Nothing changed: polled, not revived — the storm bound holds.
  await s.clock.advance(DOWN_RECHECK_MS * 3);
  expect(s.box.reads).toBe(reads + 3);
  expect(s.workers).toHaveLength(spawned);

  // Another process edited a destination (CLI, another node).
  s.box.revision = "r1";
  await s.clock.advance(DOWN_RECHECK_MS);
  expect(s.workers).toHaveLength(spawned + 1);
  expect(s.supervisor.state()).toBe("running");
});

// --- review round 2 ---------------------------------------------------------

test("repeated refused restores never start a worker beside one that has not exited", async () => {
  const s = setup({
    worker: () => fakeWorker({ ackPause: false, terminateExits: false, exitOnStop: false }),
  });
  await s.supervisor.start();
  const alive = (): number => s.workers.filter((w) => w.alive).length;
  for (let cycle = 0; cycle < 3; cycle++) {
    const pausing = s.supervisor.pause().catch((e) => e);
    await flush();
    await s.clock.advance(PAUSE_ACK_MS + TERMINATE_WAIT_MS);
    expect(((await pausing) as GatewayError).message).toBe(
      "export worker did not stop; nothing was restored",
    );
    // The route's refused path: resume, not swapped.
    await s.supervisor.resume(false);
    expect(alive()).toBe(1);
    expect(s.workers).toHaveLength(1);
    expect(s.supervisor.state()).toBe("stopping");
    // Export is unavailable meanwhile.
    const refused = (await s.supervisor
      .request({ type: "skip", id: "x" })
      .catch((e) => e)) as GatewayError;
    expect(refused.message).toBe("export worker not running");
  }
  // Polls, restarts and destination changes cannot start one either.
  await s.supervisor.destinationsChanged();
  await s.clock.advance(120_000);
  expect(s.workers).toHaveLength(1);
  expect(s.supervisor.restarts()).toBe(0);
});

test("a late exit of the stuck worker re-enables start under the normal conditions", async () => {
  const s = setup({
    worker: () => fakeWorker({ ackPause: false, terminateExits: false, exitOnStop: false }),
  });
  await s.supervisor.start();
  const stuck = s.last();
  const pausing = s.supervisor.pause().catch((e) => e);
  await flush();
  await s.clock.advance(PAUSE_ACK_MS + TERMINATE_WAIT_MS);
  await pausing;
  await s.supervisor.resume(false);
  expect(s.supervisor.state()).toBe("stopping");

  stuck.die();
  await flush();
  expect(s.workers).toHaveLength(2);
  expect(s.supervisor.state()).toBe("running");
  expect(s.workers.filter((w) => w.alive)).toHaveLength(1);
});

test("a late exit starts nothing when no destination is left, or after a failed swap", async () => {
  const none = setup({
    worker: () => fakeWorker({ ackPause: false, terminateExits: false, exitOnStop: false }),
  });
  await none.supervisor.start();
  const stuck = none.last();
  const pausing = none.supervisor.pause().catch((e) => e);
  await flush();
  await none.clock.advance(PAUSE_ACK_MS + TERMINATE_WAIT_MS);
  await pausing;
  await none.supervisor.resume(false);
  none.box.destinations = 0;
  stuck.die();
  await flush();
  expect(none.workers).toHaveLength(1);
  expect(none.supervisor.state()).toBe("idle");

  const halted = setup({ worker: () => fakeWorker({ exitOnStop: false, terminateExits: false }) });
  await halted.supervisor.start();
  await halted.supervisor.pause();
  await halted.supervisor.halt();
  halted.last().die();
  await flush();
  await halted.clock.advance(120_000);
  expect(halted.workers).toHaveLength(1);
  expect(halted.supervisor.state()).toBe("halted");
});

test("a destination re-created while the last one's worker is still stopping waits for its exit", async () => {
  const s = setup({ worker: () => fakeWorker({ exitOnStop: false }) });
  await s.supervisor.start();
  const old = s.last();
  s.box.destinations = 0;
  await s.supervisor.destinationsChanged();
  s.box.destinations = 1;
  await s.supervisor.destinationsChanged();
  expect(s.workers).toHaveLength(1);
  expect(s.supervisor.state()).toBe("stopping");
  old.die();
  await flush();
  expect(s.workers).toHaveLength(2);
  expect(s.supervisor.state()).toBe("running");
});
