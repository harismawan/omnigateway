import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, deriveKey } from "@omni/store";
import { requestLog } from "@omni/testkit";
import type { WorkerMessage } from "../../src/export/protocol.ts";
import { spawnExportWorker } from "../../src/export/spawn.ts";
import { exportDbPathFor } from "../../src/export/state/sqlite.ts";

/**
 * The real worker entry, spawned as a Bun `Worker` against a temp SQLite
 * installation and a local receiver: what the fakes in `loop.test.ts` stand
 * in for. One end-to-end path — preview, delivery, status, pause/resume,
 * stop — and the main file's `data_version` unmoved by all of it.
 */

const SECRET = "export-worker-smoke-test-encryption-key";
const dir = mkdtempSync(join(tmpdir(), "omni-export-worker-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the worker exports a settled row, answers preview, pauses, resumes and stops", async () => {
  const received: Array<{ signature: string | null; ids: string[] }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { records: Array<{ id: string }> };
      received.push({
        signature: req.headers.get("x-omni-signature"),
        ids: body.records.map((r) => r.id),
      });
      return new Response(null, { status: 204 });
    },
  });
  const path = join(dir, "omnigateway.db");
  const store = await createStore({ path, encryptionKey: await deriveKey(SECRET) });
  await store.exportDestinations.create({
    id: "hook",
    type: "webhook",
    config: { url: `http://127.0.0.1:${server.port}/in`, headers: {} },
    startFrom: "oldest",
    secret: JSON.stringify({ signingSecret: "s" }),
  });
  await store.usage.append(requestLog({ id: "req_smoke", at: Date.now() - 120_000 }));
  // Backdated past the 10 s settle lag, so the first tick finds it.
  const writer = new Database(path);
  writer.run("UPDATE request_logs SET completed_at = ? WHERE id = 'req_smoke'", [
    Date.now() - 60_000,
  ]);
  writer.close();
  // `data_version` is per connection: read twice on one, around the export.
  const probe = new Database(path);
  const dataVersion = () =>
    probe.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0;
  const before = dataVersion();

  const messages: WorkerMessage[] = [];
  const worker = spawnExportWorker({
    databasePath: path,
    databaseUrl: null,
    encryptionKey: SECRET,
    redisUrl: null,
    nodeId: "node-smoke",
    logLevel: "error",
    exportBodiesAllowed: false,
    gates: { bodyLoggingAllowed: false },
  });
  let exited = false;
  worker.onExit(() => {
    exited = true;
  });
  worker.onMessage((m) => messages.push(m));
  const waitFor = async (what: () => boolean, ms = 10_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!what()) {
      if (Date.now() > end) throw new Error("timed out");
      await Bun.sleep(20);
    }
  };

  try {
    await waitFor(() => received.length > 0);
    expect(received[0]?.ids).toEqual(["req_smoke"]);
    expect(received[0]?.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    await waitFor(() =>
      messages.some((m) => m.type === "status" && m.destinations[0]?.exportedTotal === 1),
    );
    // The worker never wrote the main file: its handle there is read-only.
    expect(dataVersion()).toBe(before);
    expect(await Bun.file(exportDbPathFor(path)).exists()).toBe(true);

    worker.post({ type: "preview", ref: "p", requestId: "req_smoke" });
    await waitFor(() => messages.some((m) => m.type === "previewResult"));
    expect(messages.find((m) => m.type === "previewResult")).toMatchObject({
      ok: true,
      record: { id: "req_smoke", nodeId: "node-smoke" },
    });

    worker.post({ type: "pause" });
    await waitFor(() => messages.some((m) => m.type === "paused"));
    worker.post({ type: "resume" });
    worker.post({ type: "test", ref: "t", id: "hook" });
    await waitFor(() => messages.some((m) => m.type === "testResult"));
    expect(messages.find((m) => m.type === "testResult")).toMatchObject({ ok: true, status: 204 });

    worker.post({ type: "stop" });
    await waitFor(() => exited);
  } finally {
    if (!exited) worker.terminate();
    probe.close();
    store.close();
    server.stop(true);
  }
}, 20_000);
