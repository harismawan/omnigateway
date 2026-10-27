import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { noopLogger } from "@omni/ir";
import { bodiesDirFor, createPostgresStore, createStore, deriveKey } from "@omni/store";
import { requestLog } from "@omni/testkit";
import { createCaptureBudget } from "../../src/bodies/budget.ts";
import { createBodyWriterHost } from "../../src/bodies/host.ts";
import type { MainMessage, WorkerMessage } from "../../src/bodies/protocol.ts";
import { createBodyWriter } from "../../src/bodies/seal.ts";
import type { CapturedParts } from "../../src/bodyCapture.ts";

const tick = () => Bun.sleep(1);
async function until(ready: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (ready()) return;
    await tick();
  }
  throw new Error("condition timed out");
}
const parts = (id: string, text = "hi"): CapturedParts => ({
  requestId: id,
  at: 1000,
  client: { request: text, response: null, truncated: false },
  attempts: [],
  error: null,
  abandoned: null,
  reservedBytes: Buffer.byteLength(text),
});

function transport(
  writer: ReturnType<typeof createBodyWriter>,
  deliver: (message: WorkerMessage) => void,
) {
  let listener = (_m: WorkerMessage) => {};
  const exits: Array<() => void> = [];
  return {
    worker: {
      post: (m: MainMessage) => {
        void writer.handle(m);
      },
      onMessage: (fn: (m: WorkerMessage) => void) => {
        listener = fn;
      },
      onExit: (fn: () => void) => {
        exits.push(fn);
      },
      terminate: () => {},
    },
    receive: (m: WorkerMessage) => {
      deliver(m);
      listener(m);
    },
    exit: () => {
      for (const fn of exits) fn();
    },
  };
}

test.skipIf(!process.env.OMNI_TEST_DATABASE_URL)(
  "a losing Postgres host releases without failing the winning pending owner",
  async () => {
    const key = await deriveKey("pg-owner");
    const store = await createPostgresStore({
      url: process.env.OMNI_TEST_DATABASE_URL ?? "",
      encryptionKey: key,
    });
    const id = `owner_${crypto.randomUUID()}`;
    await store.usage.append({ ...requestLog({ id, at: 1000 }), bodyState: "pending" });
    let winnerWritten: WorkerMessage | undefined;
    let loserDone = false;
    const failures: string[] = [];
    function make(winner: boolean) {
      const budget = createCaptureBudget(10000);
      let link: ReturnType<typeof transport>;
      const writer = createBodyWriter({
        key,
        dir: null,
        bodies: store.bodies,
        post: (m) => {
          if (winner && m.type === "written") {
            winnerWritten = m;
            return;
          }
          if (!winner && (m.type === "unowned" || m.type === "write-failed")) loserDone = true;
          link.receive(m);
        },
      });
      link = transport(writer, () => {});
      const host = createBodyWriterHost({
        spawn: () => link.worker,
        budget,
        logger: noopLogger,
        now: Date.now,
        timers,
        bodies: {
          publish: store.bodies.publish,
          fail: async (requestId) => {
            failures.push(requestId);
            await store.bodies.fail(requestId);
          },
        },
      });
      return { host, link, budget };
    }
    const a = make(true);
    const b = make(false);
    try {
      await a.host.start();
      await b.host.start();
      const first = parts(id, '"winner"');
      a.budget.reserve(first.reservedBytes);
      a.host.enqueue(first);
      await until(() => winnerWritten !== undefined);
      const second = parts(id, '"loser"');
      b.budget.reserve(second.reservedBytes);
      b.host.enqueue(second);
      await until(() => loserDone);
      await tick();
      expect(failures).toEqual([]);
      expect(b.budget.held()).toBe(0);
      expect((await store.usage.get(id))?.bodyState).toBe("pending");
      if (winnerWritten === undefined) throw new Error("no winner");
      a.link.receive(winnerWritten);
      await until(() => a.budget.held() === 0);
      expect((await store.usage.get(id))?.bodyState).toBe("ready");
      expect((await store.bodies.get(id))?.artifact?.client.request).toBe("winner");
    } finally {
      a.host.stop();
      b.host.stop();
      store.close();
    }
  },
);
const timers = {
  setTimeout,
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

test("partial budget abandonment disposes worker assemblies before releasing retained reservations", async () => {
  const key = await deriveKey("test");
  const budget = createCaptureBudget(3 * 1024 * 1024);
  let unblock = () => {};
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let writing = false;
  let retained = 0;
  let discarded = 0;
  let link: ReturnType<typeof transport>;
  const writer = createBodyWriter({
    dir: null,
    key,
    bodies: {
      writeRow: async () => {
        writing = true;
        await blocked;
        return true;
      },
    },
    post: (m) => {
      if (m.type === "slice-ack") retained += m.bytes;
      if (m.type === "discarded") {
        // Before disposal confirmation reaches the host, original reservations
        // must still cover every byte the worker held behind the blocked write.
        expect(budget.held()).toBeGreaterThanOrEqual(retained + competing);
        retained = 0;
        discarded++;
      }
      link.receive(m);
    },
  });
  link = transport(writer, () => {});
  let competing = 0;
  const host = createBodyWriterHost({
    spawn: () => link.worker,
    bodies: { publish: async () => true, fail: async () => {} },
    budget,
    logger: noopLogger,
    now: Date.now,
    timers,
    yield: async () => {
      competing = 1024 * 1024;
      expect(budget.reserve(competing)).toBe(true);
      await tick();
    },
  });
  await host.start();
  host.enqueue(parts("block", ""));
  await until(() => writing);
  try {
    for (let i = 0; i < 12; i++) {
      const p = parts(`partial_${i}`, "x".repeat(2 * 1024 * 1024));
      expect(budget.reserve(p.reservedBytes)).toBe(true);
      host.enqueue(p);
      await until(() => discarded === i + 1);
      expect(retained).toBe(0);
      expect(budget.held()).toBe(competing);
      budget.release(competing);
      competing = 0;
    }
  } finally {
    host.stop();
    unblock();
  }
});

for (const mode of ["stop", "halt", "drain", "publication-error"] as const)
  for (const committed of [false, true]) {
    test(`${mode} preserves SQLite owner while publication decision is ${committed ? "committed" : "pending"}`, async () => {
      const root = await mkdtemp("/tmp/opencode/body-owner-");
      const key = await deriveKey("owner-test");
      let host: ReturnType<typeof createBodyWriterHost>;
      const store = await createStore({
        path: join(root, "main.sqlite"),
        encryptionKey: key,
        isPending: (p) => host?.isPending(p) ?? false,
      });
      await store.usage.append({ ...requestLog({ id: "race", at: 1000 }), bodyState: "pending" });
      let decide = () => {};
      const decision = new Promise<void>((resolve) => {
        decide = resolve;
      });
      let entered = false;
      let done = false;
      const budget = createCaptureBudget(10000);
      let link: ReturnType<typeof transport>;
      const writer = createBodyWriter({
        key,
        dir: bodiesDirFor(store.databasePath),
        post: (m) => link.receive(m),
      });
      link = transport(writer, () => {});
      host = createBodyWriterHost({
        spawn: () => link.worker,
        bodies: {
          fail: store.bodies.fail,
          publish: async (row) => {
            let accepted = false;
            if (committed) accepted = await store.bodies.publish(row);
            entered = true;
            await decision;
            if (!committed) accepted = await store.bodies.publish(row);
            done = true;
            if (mode === "publication-error") throw new Error("reply lost after commit");
            return accepted;
          },
        },
        budget,
        logger: noopLogger,
        now: Date.now,
        timers:
          mode === "drain"
            ? {
                setTimeout: (fn, ms) => setTimeout(fn, ms === 5000 ? 5 : ms),
                clearTimeout: timers.clearTimeout,
              }
            : timers,
      });
      try {
        await host.start();
        const p = parts("race");
        budget.reserve(p.reservedBytes);
        host.enqueue(p);
        await until(() => entered);
        let drained = false;
        let draining: Promise<void> | undefined;
        if (mode === "stop") host.stop();
        else if (mode === "halt") await host.halt();
        else if (mode === "drain")
          draining = host.drain().then(() => {
            drained = true;
          });
        await Bun.sleep(15);
        if (mode === "drain") expect(drained).toBe(false);
        decide();
        await until(() => done);
        await draining;
        await tick();
        expect((await store.usage.get("race"))?.bodyState).toBe("ready");
        expect((await store.bodies.get("race"))?.row.detailState).toBe("ready");
        expect(host.isPending("1970/01/01/race.json.enc")).toBe(true);
        link.exit();
        expect(host.isPending("1970/01/01/race.json.enc")).toBe(false);
        expect(budget.held()).toBe(0);
      } finally {
        decide();
        host.stop();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

test("old written ACK and late captured parts cannot publish into an actually restored SQLite DB", async () => {
  const root = await mkdtemp("/tmp/opencode/body-restore-");
  const key = await deriveKey("restore-body-test");
  const path = join(root, "main.sqlite");
  const store = await createStore({ path, encryptionKey: key });
  const snapshot = join(root, "snapshot.sqlite");
  const budget = createCaptureBudget(10000);
  let held: WorkerMessage | undefined;
  let link: ReturnType<typeof transport>;
  const writer = createBodyWriter({
    key,
    dir: bodiesDirFor(path),
    post: (m) => {
      if (m.type === "written") held = m;
      else link.receive(m);
    },
  });
  link = transport(writer, () => {});
  const host = createBodyWriterHost({
    spawn: () => link.worker,
    bodies: store.bodies,
    budget,
    logger: noopLogger,
    now: Date.now,
    timers,
  });
  try {
    // Both snapshots and old runtime use this same id: row guards alone cannot fence it.
    await store.usage.append({ ...requestLog({ id: "reused", at: 1000 }), bodyState: "pending" });
    await store.maintenance.snapshotTo(snapshot);
    await host.start();
    const old = parts("reused");
    budget.reserve(old.reservedBytes);
    host.enqueue(old);
    await until(() => held !== undefined);
    await host.pause();
    expect((await store.usage.get("reused"))?.bodyState).toBe("failed");
    store.close();
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
    await copyFile(snapshot, path);
    await store.reopen();
    await host.resume(true);
    if (held === undefined) throw new Error("missing old acknowledgement");
    link.receive(held);
    const late = parts("reused");
    late.generation = 0;
    budget.reserve(late.reservedBytes);
    host.enqueue(late);
    await tick();
    expect((await store.usage.get("reused"))?.bodyState).toBe("pending");
    expect(await store.bodies.get("reused")).toBeNull();
    expect(budget.held()).toBe(0);
  } finally {
    host.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("refused publication during successful pause clears pending paths across repeated resumes", async () => {
  const root = await mkdtemp("/tmp/opencode/body-pause-refusal-");
  const key = await deriveKey("pause-refusal-test");
  let host: ReturnType<typeof createBodyWriterHost>;
  const store = await createStore({
    path: join(root, "main.sqlite"),
    encryptionKey: key,
    isPending: (path) => host?.isPending(path) ?? false,
  });
  const budget = createCaptureBudget(10000);
  let link: ReturnType<typeof transport>;
  let entered = false;
  let decide = () => {};
  let decision = Promise.resolve();
  let spawns = 0;
  let cleaned = 0;
  const writer = createBodyWriter({
    key,
    dir: bodiesDirFor(store.databasePath),
    post: (message) => link.receive(message),
  });
  link = transport(writer, (message) => {
    if (message.type === "cleaned") cleaned++;
  });
  host = createBodyWriterHost({
    spawn: () => {
      spawns++;
      return link.worker;
    },
    bodies: {
      fail: store.bodies.fail,
      publish: async (row) => {
        entered = true;
        await decision;
        return store.bodies.publish(row);
      },
    },
    budget,
    logger: noopLogger,
    now: Date.now,
    timers,
  });
  const paths: string[] = [];
  try {
    await host.start();
    for (let cycle = 0; cycle < 8; cycle++) {
      const id = `refused_${cycle}`;
      const path = `1970/01/01/${id}.json.enc`;
      paths.push(path);
      await store.usage.append({ ...requestLog({ id, at: 1000 }), bodyState: "pending" });
      // The main repository must refuse the publication, not a test-only result.
      await store.bodies.fail(id);
      entered = false;
      decision = new Promise<void>((resolve) => {
        decide = resolve;
      });
      const p = parts(id);
      budget.reserve(p.reservedBytes);
      host.enqueue(p);
      await until(() => entered);
      expect(host.isPending(path)).toBe(true);
      expect(await Bun.file(join(bodiesDirFor(store.databasePath), path)).exists()).toBe(true);
      const pausing = host.pause();
      await tick(); // Pause closes admission while the main decision is pending.
      decide();
      await pausing;
      expect(cleaned).toBe(cycle + 1);
      expect(await Bun.file(join(bodiesDirFor(store.databasePath), path)).exists()).toBe(false);
      expect(paths.filter((candidate) => host.isPending(candidate))).toEqual([]);
      expect(budget.held()).toBe(0);
      await host.resume(false);
      expect(paths.filter((candidate) => host.isPending(candidate))).toEqual([]);
      expect(spawns).toBe(1); // No thread close/restart repairs these paths for us.
    }
  } finally {
    decide();
    host.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
