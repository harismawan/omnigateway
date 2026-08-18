import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_COOKIE, createAdminAuth, type DatabaseDeps, nodeDatabaseFs } from "@omni/control";
import { createStore, deriveKey } from "@omni/store";
import { virtualModel } from "@omni/testkit";
import { createQuiesceLatch } from "../../src/quiesce.ts";
import { type DatabaseRouteDeps, databaseRoutes } from "../../src/routes/database.ts";

const NOW = Date.parse("2026-08-18T04:12:03.114Z");
const SESSION_TTL_MS = 60_000;
const SNAPSHOT_ID = "db_2026-08-18T04-12-03-114Z_manual.sqlite";

type HarnessOptions = {
  configured?: boolean;
  /** The admin password this installation is set up with. Two harnesses differ by it. */
  password?: string;
  /** Folded over the real filesystem, for the one seam a test needs to fail. */
  fs?: Partial<DatabaseDeps["fs"]>;
  lifecycle?: Partial<DatabaseRouteDeps["lifecycle"]>;
  maxImportBytes?: number;
};

/**
 * The route surface over a real database in a real temporary directory.
 *
 * `VACUUM INTO` needs a file and a restore replaces one, so the store is the
 * one thing here that cannot be faked. Everything the gateway itself would
 * reach for is: the command runner, the stop effect, and whichever filesystem
 * call a test wants to break.
 */
async function harness(options: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omni-db-routes-"));
  const store = await createStore({
    path: join(dir, "omnigateway.db"),
    encryptionKey: await deriveKey("test-encryption-key-0123456789"),
  });
  const admin = createAdminAuth(store, { now: () => NOW, sessionTtlMs: SESSION_TTL_MS });

  let cookie = "";
  /** Logs in and makes that the session `call` sends. Every later call is it. */
  const login = async (password: string) => {
    const token = await admin.login(password);
    if (token === null) throw new Error("test admin login failed");
    cookie = `${ADMIN_COOKIE}=${token}`;
  };
  if (options.configured !== false) {
    await admin.setPassword(options.password ?? "hunter2hunter2");
    await login(options.password ?? "hunter2hunter2");
  }

  const runs: string[][] = [];
  const stops: number[] = [];
  const latch = createQuiesceLatch();
  const app = databaseRoutes({
    store,
    admin,
    latch,
    now: () => NOW,
    fs: { ...nodeDatabaseFs(), ...options.fs },
    quiesceDeadlineMs: 50,
    ...(options.maxImportBytes === undefined ? {} : { maxImportBytes: options.maxImportBytes }),
    lifecycle: {
      env: {},
      fileExists: () => false,
      run: async (argv) => {
        runs.push([...argv]);
        return { code: 0, stdout: "", stderr: "" };
      },
      stop: (code) => stops.push(code),
      ...options.lifecycle,
    },
  });

  const auth = (on: boolean) => (on && cookie.length > 0 ? { cookie } : {});

  const call = (method: string, path: string, body?: unknown, authenticated = true) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json", ...auth(authenticated) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  const upload = (bytes: Uint8Array, authenticated = true) =>
    app.handle(
      new Request("http://localhost/api/database/import", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...auth(authenticated) },
        body: bytes,
      }),
    );

  const snapshot = async (): Promise<{ id: string; sizeBytes: number; reason: string }> =>
    (await (await call("POST", "/api/database/snapshots")).json()) as {
      id: string;
      sizeBytes: number;
      reason: string;
    };

  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return { dir, store, admin, app, latch, call, login, upload, snapshot, runs, stops, cleanup };
}

test("the overview reports the file, the pages, retention, and the snapshots", async () => {
  const { call, cleanup } = await harness();

  const body = (await (await call("GET", "/api/database")).json()) as {
    stats: { pageSize: number; pageCount: number; schemaVersion: number };
    fileBytes: number;
    logicalBytes: number;
    retention: { keepLatest: number; maxAgeDays: number };
    snapshots: { count: number; totalBytes: number; latestAt: number | null };
  };

  expect(body.stats.pageSize).toBeGreaterThan(0);
  expect(body.stats.pageCount).toBeGreaterThan(0);
  expect(body.stats.schemaVersion).toBeGreaterThan(0);
  expect(body.fileBytes).toBeGreaterThan(0);
  expect(body.logicalBytes).toBe(body.stats.pageSize * body.stats.pageCount);
  expect(body.retention.keepLatest).toBeGreaterThan(0);
  expect(body.snapshots).toEqual({ count: 0, totalBytes: 0, latestAt: null });

  cleanup();
});

test("a vacuum reports what it reclaimed and how long it took", async () => {
  const { call, cleanup } = await harness();

  const body = (await (await call("POST", "/api/database/vacuum")).json()) as {
    ok: boolean;
    reclaimedBytes: number;
    durationMs: number;
  };

  expect(body.ok).toBe(true);
  expect(body.reclaimedBytes).toBeGreaterThanOrEqual(0);
  expect(body.durationMs).toBeGreaterThanOrEqual(0);

  cleanup();
});

test("a created snapshot is listed, downloadable, and deletable", async () => {
  const { call, snapshot, cleanup } = await harness();

  const created = await snapshot();
  expect(created.id).toBe(SNAPSHOT_ID);
  expect(created.reason).toBe("manual");
  expect(created.sizeBytes).toBeGreaterThan(0);

  const listed = (await (await call("GET", "/api/database/snapshots")).json()) as {
    snapshots: { id: string; sizeBytes: number; createdAt: number; reason: string }[];
  };
  expect(listed.snapshots.map((s) => s.id)).toEqual([created.id]);
  expect(listed.snapshots[0]?.createdAt).toBe(NOW);

  const download = await call("GET", `/api/database/snapshots/${created.id}/download`);
  expect(download.status).toBe(200);
  expect(download.headers.get("cache-control")).toBe("no-store");
  expect(download.headers.get("content-disposition")).toBe(`attachment; filename="${created.id}"`);
  const bytes = new Uint8Array(await download.arrayBuffer());
  expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe("SQLite format 3");

  expect(await (await call("DELETE", `/api/database/snapshots/${created.id}`)).json()).toEqual({
    ok: true,
  });
  const after = (await (await call("GET", "/api/database/snapshots")).json()) as {
    snapshots: unknown[];
  };
  expect(after.snapshots).toEqual([]);

  cleanup();
});

test("a snapshot id that is not one is refused rather than resolved", async () => {
  const { call, cleanup } = await harness();

  for (const id of ["..%2Fomnigateway.db", "nonsense.sqlite"]) {
    expect((await call("GET", `/api/database/snapshots/${id}/download`)).status).toBe(400);
    expect((await call("DELETE", `/api/database/snapshots/${id}`)).status).toBe(400);
    expect((await call("POST", `/api/database/snapshots/${id}/restore`)).status).toBe(400);
  }

  cleanup();
});

test("a restore puts the snapshot's contents back and reopens the latch", async () => {
  const { call, store, latch, snapshot, cleanup } = await harness();

  const created = await snapshot();
  await store.config.putModel(virtualModel({ id: "after-the-snapshot", targets: [] }));
  expect((await store.config.listModels()).map((m) => m.id)).toEqual(["after-the-snapshot"]);

  const restored = await call("POST", `/api/database/snapshots/${created.id}/restore`);
  expect(restored.status).toBe(200);
  const body = (await restored.json()) as {
    ok: boolean;
    counts: Record<string, number>;
    preRestoreSnapshot: { id: string; reason: string };
  };
  expect(body.ok).toBe(true);
  expect(body.counts.virtual_models).toBe(0);
  expect(body.preRestoreSnapshot.reason).toBe("preRestore");

  // The repo reference here was taken before the swap and is read after it.
  expect(await store.config.listModels()).toEqual([]);
  expect(latch.isClosed()).toBe(false);

  cleanup();
});

/**
 * The invariant `setPassword` protects, reached the other way round.
 *
 * Sessions live in memory and are trusted against whatever hash is on disk, so
 * a restore that brings a different admin password in leaves this process
 * honouring a cookie for a password the installation no longer has. Nobody
 * called `setPassword`, so nothing cleared them.
 */
test("a restore that changes the admin password ends the session that asked for it", async () => {
  const { call, login, admin, snapshot, cleanup } = await harness();

  const created = await snapshot();
  await admin.setPassword("correct-horse-battery");
  await login("correct-horse-battery");
  expect((await call("GET", "/api/database")).status).toBe(200);

  const restored = await call("POST", `/api/database/snapshots/${created.id}/restore`);
  // The operator asked for this, so the operator is told how it went. Their own
  // response is not the one the invalidation is allowed to eat.
  expect(restored.status).toBe(200);
  expect(((await restored.json()) as { adminPasswordChanged: boolean }).adminPasswordChanged).toBe(
    true,
  );

  expect((await call("GET", "/api/database")).status).toBe(401);

  cleanup();
});

test("a restore of this installation's own snapshot leaves the session alone", async () => {
  const { call, snapshot, cleanup } = await harness();

  const created = await snapshot();
  const restored = await call("POST", `/api/database/snapshots/${created.id}/restore`);

  expect(restored.status).toBe(200);
  expect(((await restored.json()) as { adminPasswordChanged: boolean }).adminPasswordChanged).toBe(
    false,
  );
  // The whole reason the hashes are compared instead of assumed to differ.
  expect((await call("GET", "/api/database")).status).toBe(200);

  cleanup();
});

test("a swap that failed keeps the latch closed", async () => {
  const { call, latch, snapshot, cleanup } = await harness({
    fs: {
      rename: () => {
        throw new Error("EXDEV");
      },
    },
  });

  const created = await snapshot();
  const restored = await call("POST", `/api/database/snapshots/${created.id}/restore`);

  expect(restored.status).toBe(500);
  expect(latch.isClosed()).toBe(true);

  cleanup();
});

test("a failure before the swap releases the latch, because the database is untouched", async () => {
  const { upload, latch, dir, cleanup } = await harness();

  const refused = await upload(new TextEncoder().encode("not a database at all"));
  expect(refused.status).toBe(400);
  expect(latch.isClosed()).toBe(false);
  // The staged upload went with the refusal.
  expect(readdirSync(dir).filter((name) => name.includes("import"))).toEqual([]);

  cleanup();
});

test("an imported database replaces the live one", async () => {
  const source = await harness();
  await source.store.config.putModel(virtualModel({ id: "from-the-import", targets: [] }));
  const created = await source.snapshot();
  const bytes = new Uint8Array(
    await Bun.file(join(source.dir, "snapshots", created.id)).arrayBuffer(),
  );

  const target = await harness();
  const imported = await target.upload(bytes);
  expect(imported.status).toBe(200);
  expect((await target.store.config.listModels()).map((m) => m.id)).toEqual(["from-the-import"]);
  expect(target.latch.isClosed()).toBe(false);

  source.cleanup();
  target.cleanup();
});

/**
 * The same invariant on the other route, where it is the likely case.
 *
 * An imported database came from somewhere else, so its admin password is
 * somebody else's by default — the operator who uploads one is the operator
 * whose session must not survive it.
 */
test("an import from an installation with another password ends the session", async () => {
  const source = await harness({ password: "correct-horse-battery" });
  const created = await source.snapshot();
  const bytes = new Uint8Array(
    await Bun.file(join(source.dir, "snapshots", created.id)).arrayBuffer(),
  );

  const target = await harness();
  const imported = await target.upload(bytes);
  expect(imported.status).toBe(200);
  expect(((await imported.json()) as { adminPasswordChanged: boolean }).adminPasswordChanged).toBe(
    true,
  );
  expect((await target.call("GET", "/api/database")).status).toBe(401);

  source.cleanup();
  target.cleanup();
});

test("an import stops at the byte cap instead of writing the whole body", async () => {
  const { upload, dir, cleanup } = await harness({ maxImportBytes: 64 });

  const response = await upload(new Uint8Array(4_096));
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
    "64 bytes",
  );
  expect(readdirSync(dir).filter((name) => name.includes("import"))).toEqual([]);
  // The live database is exactly where it was.
  expect(existsSync(join(dir, "omnigateway.db"))).toBe(true);

  cleanup();
});

test("retention is validated and persisted", async () => {
  const { call, store, cleanup } = await harness();

  const saved = await call("PUT", "/api/database/retention", { keepLatest: 3, maxAgeDays: 7 });
  expect(await saved.json()).toEqual({ keepLatest: 3, maxAgeDays: 7 });
  const settings = await store.config.getSettings();
  expect(settings.snapshotKeepLatest).toBe(3);
  expect(settings.snapshotMaxAgeDays).toBe(7);

  expect((await call("PUT", "/api/database/retention", { keepLatest: 0 })).status).toBe(400);

  cleanup();
});

test("lifecycle reports what would restart this process", async () => {
  const { call, cleanup } = await harness();

  expect(await (await call("GET", "/api/lifecycle")).json()).toEqual({
    supervisor: "none",
    canRestart: false,
    canShutdown: true,
    note: "no supervisor is watching this process, so nothing would start it again",
  });

  cleanup();
});

test("a restart with no supervisor is a conflict rather than a lie", async () => {
  const { call, runs, stops, cleanup } = await harness();

  expect((await call("POST", "/api/lifecycle/restart")).status).toBe(409);
  expect(runs).toEqual([]);
  expect(stops).toEqual([]);

  cleanup();
});

test("a restart under systemd asks the manager, and answers before it goes", async () => {
  const { call, runs, cleanup } = await harness({
    lifecycle: { env: { JOURNAL_STREAM: "8:12345", MANAGERPID: "900" } },
  });

  const response = await call("POST", "/api/lifecycle/restart");
  expect(await response.json()).toEqual({ ok: true });
  expect(runs).toEqual([["systemctl", "--user", "--no-block", "restart", "omnigateway.service"]]);

  cleanup();
});

test("a shutdown answers, and hands the stop effect a clean exit", async () => {
  const { call, stops, cleanup } = await harness();

  const response = await call("POST", "/api/lifecycle/shutdown");
  expect(await response.json()).toEqual({ ok: true });
  expect(stops).toEqual([0]);

  cleanup();
});

/**
 * The defect this whole surface is modelled away from.
 *
 * The reference implementation's restart and import routes are reachable with
 * no session at all on an installation that never set a password, so every
 * route here is asserted unauthenticated — not a representative sample.
 */
test("every route requires an admin session", async () => {
  const { call, upload, dir, runs, stops, cleanup } = await harness();

  const routes: [string, string][] = [
    ["GET", "/api/database"],
    ["POST", "/api/database/vacuum"],
    ["GET", "/api/database/snapshots"],
    ["POST", "/api/database/snapshots"],
    ["GET", `/api/database/snapshots/${SNAPSHOT_ID}/download`],
    ["DELETE", `/api/database/snapshots/${SNAPSHOT_ID}`],
    ["POST", `/api/database/snapshots/${SNAPSHOT_ID}/restore`],
    ["PUT", "/api/database/retention"],
    ["GET", "/api/lifecycle"],
    ["POST", "/api/lifecycle/restart"],
    ["POST", "/api/lifecycle/shutdown"],
  ];

  for (const [method, path] of routes) {
    const response = await call(method, path, undefined, false);
    expect(`${method} ${path} -> ${response.status}`).toBe(`${method} ${path} -> 401`);
  }
  expect((await upload(new Uint8Array([1, 2, 3]), false)).status).toBe(401);

  // Nothing ran, and nothing was written, on the way to any of those refusals.
  expect(runs).toEqual([]);
  expect(stops).toEqual([]);
  expect(readdirSync(dir).includes("snapshots")).toBe(false);

  cleanup();
});
