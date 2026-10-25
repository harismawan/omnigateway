import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, deriveKey } from "@omni/store";
import { captureLogger } from "@omni/testkit";
import { spawnExportWorker } from "../../src/export/spawn.ts";
import { createExportSupervisor } from "../../src/exportHost/supervisor.ts";

/**
 * The supervisor over the real worker: what the fakes in `supervisor.test.ts`
 * stand in for. A preview round trip, a restore's pause and resume, a stop.
 */

const SECRET = "export-supervisor-real-worker-key";
const dir = mkdtempSync(join(tmpdir(), "omni-export-supervisor-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the real worker answers through the supervisor, pauses for a restore, resumes, and stops", async () => {
  const path = join(dir, "omnigateway.db");
  const store = await createStore({ path, encryptionKey: await deriveKey(SECRET) });
  await store.exportDestinations.create({
    id: "hook",
    type: "webhook",
    config: { url: "http://127.0.0.1:9/in", headers: {} },
    startFrom: "now",
  });
  const supervisor = createExportSupervisor({
    init: {
      databasePath: path,
      databaseUrl: null,
      encryptionKey: SECRET,
      redisUrl: null,
      nodeId: "node-real",
      logLevel: "error",
      exportBodiesAllowed: false,
      gates: { bodyLoggingAllowed: false },
    },
    spawn: spawnExportWorker,
    readDestinations: async () => {
      const list = await store.exportDestinations.list();
      return { count: list.length, revision: list.map((d) => d.updatedAt).join(",") };
    },
    timers: { setTimeout, clearTimeout: (h) => clearTimeout(h as Timer) },
    now: Date.now,
    logger: captureLogger(),
  });
  try {
    await supervisor.start();
    expect(supervisor.state()).toBe("running");
    expect(await supervisor.request({ type: "preview", requestId: "req_none" })).toMatchObject({
      ok: false,
      error: "no such request",
    });

    const started = Date.now();
    await supervisor.pause();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(supervisor.state()).toBe("paused");
    await supervisor.resume(true);
    expect(supervisor.state()).toBe("running");
    expect(await supervisor.request({ type: "skip", id: "hook" })).toMatchObject({ ok: true });
    expect(supervisor.restarts()).toBe(0);
  } finally {
    supervisor.stop();
    store.close();
  }
  expect(supervisor.state()).toBe("stopped");
}, 20_000);
