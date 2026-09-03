import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADMIN_COOKIE,
  createAdminAuth,
  type DatabaseDeps,
  type DatabaseStore,
  nodeDatabaseFs,
} from "@omni/control";
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
  /** The one step of a restore that runs after the swap has already succeeded. */
  rebuildRollupFails?: boolean;
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
  /**
   * The database clock, which a test may move; the session clock, which it may not.
   *
   * Snapshots are named after the instant they were taken, so two operations at
   * one frozen instant collide on the filename. A test that runs two of them
   * moves this rather than the session TTL it is not making a point about.
   */
  const clock = { now: NOW };

  /**
   * A seam to park a whole-database operation at, for the tests about two of them.
   *
   * `snapshotTo` is where every mutating operation spends real time — a restore
   * takes its undo snapshot through it — so holding it holds a restore exactly
   * where a concurrent one would find it: latch shut, swap not begun. Spread
   * rather than mutated, because the store's repos forward per call and the
   * outer object is what survives a reopen.
   */
  let held: Promise<void> | null = null;
  const routeStore: DatabaseStore = {
    ...store,
    maintenance: {
      ...store.maintenance,
      snapshotTo: async (path) => {
        if (held !== null) await held;
        await store.maintenance.snapshotTo(path);
      },
    },
    usage: {
      rebuildRollup: async () => {
        if (options.rebuildRollupFails === true) throw new Error("no space left on device");
        await store.usage.rebuildRollup();
      },
    },
  };

  /**
   * How many times every console was told its whole database moved.
   *
   * Counted on every harness rather than only where a test reads it: these
   * routes take the broadcaster as an option, so a harness that omitted it
   * would make "did not invalidate" indistinguishable from "was never wired".
   */
  let invalidatedAll = 0;

  const app = databaseRoutes({
    store: routeStore,
    admin,
    latch,
    broadcaster: {
      invalidateAll: () => {
        invalidatedAll += 1;
      },
    },
    now: () => clock.now,
    fs: { ...nodeDatabaseFs(), ...options.fs },
    quiesceDeadlineMs: 50,
    ...(options.maxImportBytes === undefined ? {} : { maxImportBytes: options.maxImportBytes }),
    lifecycle: {
      env: {},
      version: "1.2.3",
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

  /** The same route, with a body that declares no length. */
  const uploadStream = (body: ReadableStream<Uint8Array>) =>
    app.handle(
      new Request("http://localhost/api/database/import", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...auth(true) },
        body,
        duplex: "half",
      } as RequestInit),
    );

  const snapshot = async (): Promise<{ id: string; sizeBytes: number; reason: string }> =>
    (await (await call("POST", "/api/database/snapshots")).json()) as {
      id: string;
      sizeBytes: number;
      reason: string;
    };

  /** Parks the next whole-database operation until `promise` settles. */
  const holdSnapshots = (promise: Promise<void>) => {
    held = promise;
  };

  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return {
    dir,
    store,
    admin,
    app,
    latch,
    clock,
    holdSnapshots,
    invalidations: () => invalidatedAll,
    call,
    login,
    upload,
    uploadStream,
    snapshot,
    runs,
    stops,
    cleanup,
  };
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

test("clearing bodies deletes every row and file, and leaves the request logged", async () => {
  const { call, store, dir, cleanup } = await harness();
  await store.bodies.put({
    schemaVersion: 1,
    requestId: "req_11111111-2222-4333-8444-555555555555",
    at: NOW - 1,
    client: { request: { model: "fast" }, response: { ok: true }, truncated: false },
    attempts: [],
    error: null,
  });
  const bodiesDir = join(dir, "request_bodies");
  const artifacts = () => [...new Bun.Glob("**/*.json.enc").scanSync(bodiesDir)];
  expect(artifacts()).toHaveLength(1);

  const body = (await (await call("DELETE", "/api/database/bodies")).json()) as {
    ok: boolean;
    removed: number;
    orphans: number;
  };
  expect(body).toEqual({ ok: true, removed: 1, orphans: 0 });
  expect(await store.bodies.get("req_11111111-2222-4333-8444-555555555555")).toBeNull();
  // The tree is empty of artifacts, not merely of rows.
  expect(artifacts()).toEqual([]);

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

/**
 * The same invariant, with the restore's last step broken.
 *
 * The rollup rebuild runs after the swap has already succeeded, so a throw from
 * it used to surface as a failed restore — and this route only reads
 * `adminPasswordChanged` on the success path. The database on disk was the
 * restored one either way, which left the new password live and every session
 * minted under the old one still valid. Asserting the 401 rather than the
 * response body, because the invalidation is the security property and the
 * boolean is only how it is reached.
 */
test("a restore whose rollup rebuild fails still ends the session it invalidated", async () => {
  const { call, login, admin, snapshot, cleanup } = await harness({ rebuildRollupFails: true });

  const created = await snapshot();
  await admin.setPassword("correct-horse-battery");
  await login("correct-horse-battery");
  expect((await call("GET", "/api/database")).status).toBe(200);

  const restored = await call("POST", `/api/database/snapshots/${created.id}/restore`);
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

test("a completed swap tells every console that everything it holds is stale", async () => {
  // The one event for which a global invalidate is literally true: every query
  // key the console is holding was read out of a file that is no longer there.
  const { call, snapshot, invalidations, cleanup } = await harness();

  const created = await snapshot();
  expect(invalidations()).toBe(0);

  expect((await call("POST", `/api/database/snapshots/${created.id}/restore`)).status).toBe(200);

  expect(invalidations()).toBe(1);

  cleanup();
});

/**
 * The invalidation that must not happen, and the reason it is a test of its own.
 *
 * A `SwapFailedError` is the one failure that leaves the file on disk in an
 * unknown state, which is why the latch stays shut and the store is deliberately
 * not reopened. Telling every console to throw away what it holds and refetch is
 * strictly worse than telling it nothing: the reads fail against a store that
 * did not come back, and the panel that goes blank is the database panel — the
 * one naming the pre-restore snapshot the operator is supposed to recover from.
 *
 * `invalidateAll` is also uncoalesced by design, so there is no floor between
 * this mistake and every open tab.
 */
test("a swap that failed does not tell any console to refetch", async () => {
  const { call, latch, snapshot, invalidations, cleanup } = await harness({
    fs: {
      rename: () => {
        throw new Error("EXDEV");
      },
    },
  });

  const created = await snapshot();
  const restored = await call("POST", `/api/database/snapshots/${created.id}/restore`);

  // The failure the emit must not ride along with, asserted rather than assumed:
  // a restore that failed before the swap would prove nothing here.
  expect(restored.status).toBe(500);
  expect(latch.isClosed()).toBe(true);
  expect(invalidations()).toBe(0);

  cleanup();
});

/**
 * Ordering, pinned where it has already been broken once.
 *
 * Nothing may sit between the swap and the admin-password comparison: the swap
 * has succeeded by then, so anything that throws in front of that block skips
 * the logout while the restored password is live. The emit therefore goes last.
 * A restore whose rollup rebuild fails is the case that found this the first
 * time, and it exercises both halves at once.
 */
test("a restore that ended a session still announced the swap that ended it", async () => {
  const { call, login, admin, snapshot, invalidations, cleanup } = await harness({
    rebuildRollupFails: true,
  });

  const created = await snapshot();
  await admin.setPassword("correct-horse-battery");
  await login("correct-horse-battery");

  const restored = await call("POST", `/api/database/snapshots/${created.id}/restore`);
  expect(restored.status).toBe(200);

  // The session is gone, which is the invariant, and the frame still went out.
  expect((await call("GET", "/api/database")).status).toBe(401);
  expect(invalidations()).toBe(1);

  cleanup();
});

/**
 * The documented recovery path, exercised rather than described.
 *
 * A failed swap points the operator at the pre-restore snapshot and keeps
 * `/api/*` up so they can reach it. Both halves of that need an open handle:
 * the panel reads PRAGMAs through it, and the second attempt takes its own undo
 * snapshot through it. A swap that leaves the database closed leaves the panel
 * blank and turns the retry into a different, unrecognised failure.
 */
test("after a failed swap the panel still answers and a second attempt still runs", async () => {
  const failing = { fail: true };
  const { call, clock, latch, snapshot, cleanup } = await harness({
    fs: {
      rename: (from: string, to: string) => {
        if (failing.fail) throw new Error("EXDEV");
        renameSync(from, to);
      },
    },
  });

  const created = await snapshot();
  expect((await call("POST", `/api/database/snapshots/${created.id}/restore`)).status).toBe(500);

  // The panel the operator reads the failure on.
  const overview = await call("GET", "/api/database");
  expect(overview.status).toBe(200);
  const listed = (await (await call("GET", "/api/database/snapshots")).json()) as {
    snapshots: { reason: string }[];
  };
  expect(listed.snapshots.map((s) => s.reason)).toContain("preRestore");

  // And the retry, which succeeds and puts client traffic back. The clock moves
  // because the second attempt takes its own undo snapshot, and a snapshot is
  // named after the instant it was taken.
  failing.fail = false;
  clock.now = NOW + 1_000;
  expect((await call("POST", `/api/database/snapshots/${created.id}/restore`)).status).toBe(200);
  expect(latch.isClosed()).toBe(false);

  cleanup();
});

/**
 * Two mutating requests at once: a double-clicked button, or two open tabs.
 *
 * The second one is refused by the single-flight guard in `@omni/control`, but
 * the refusal arrives at the gateway *after* the gateway closed the latch for
 * it — and the latch it closed was already closed, by the restore that is
 * mid-swap. A caller that reopens on any failure therefore admits `/v1` traffic
 * against a database that is between `close()` and `reopen()`, which is exactly
 * the window the latch exists to cover.
 */
test("a second mutating request is refused without speaking for the first one's latch", async () => {
  const { call, latch, snapshot, holdSnapshots, cleanup } = await harness();
  const created = await snapshot();

  // The first restore, parked inside its pre-restore snapshot with the latch
  // shut: past the close, nowhere near the reopen.
  const gate = Promise.withResolvers<void>();
  holdSnapshots(gate.promise);
  const first = call("POST", `/api/database/snapshots/${created.id}/restore`);
  try {
    await Bun.sleep(20);
    expect(latch.isClosed()).toBe(true);

    const second = await call("POST", `/api/database/snapshots/${created.id}/restore`);
    expect(second.status).toBe(409);
    expect(latch.isClosed()).toBe(true);
  } finally {
    // The exclusive lock in `@omni/control` is process-wide, so a failed
    // assertion here would leave the parked restore holding it and every later
    // test in this file would fail as a conflict instead of on its own merits.
    gate.resolve();
    await first;
  }

  expect((await first).status).toBe(200);
  expect(latch.isClosed()).toBe(false);

  cleanup();
});

/**
 * The other half of two overlapping operations: what the refused one wrote.
 *
 * An import stages its body beside the live database before the operation runs,
 * and the operation can reject before it ever takes ownership of that file.
 * `@omni/control` removes the staged file on every path it does own, so nothing
 * else does — and nothing sweeps the installation directory for `.part` files,
 * so a refused import leaves up to the byte cap on the operator's disk.
 */
test("an import refused by a concurrent operation does not leave its upload behind", async () => {
  const { call, upload, dir, snapshot, holdSnapshots, cleanup } = await harness();
  const created = await snapshot();

  const gate = Promise.withResolvers<void>();
  holdSnapshots(gate.promise);
  const first = call("POST", `/api/database/snapshots/${created.id}/restore`);
  try {
    await Bun.sleep(20);

    const refused = await upload(new TextEncoder().encode("a database, notionally"));
    expect(refused.status).toBe(409);
    expect(readdirSync(dir).filter((name) => name.endsWith(".part"))).toEqual([]);
  } finally {
    // As above: the lock is process-wide and must not outlive this test.
    gate.resolve();
    await first;
  }

  expect((await first).status).toBe(200);

  cleanup();
});

/**
 * The staging copy, which happens before anything is closed.
 *
 * An import stages with `rename` — the restore above stages with `copyFile` and
 * only reaches `rename` after the close — so breaking `rename` here trips the
 * pre-close branch specifically. A full disk at this point has touched nothing,
 * and answering it by refusing every `/v1` request until the process restarts
 * is a self-inflicted outage.
 */
test("an import whose staging fails leaves the latch open, because nothing was swapped", async () => {
  const source = await harness();
  const created = await source.snapshot();
  const bytes = new Uint8Array(
    await Bun.file(join(source.dir, "snapshots", created.id)).arrayBuffer(),
  );

  const target = await harness({
    fs: {
      rename: () => {
        throw new Error("ENOSPC: no space left on device");
      },
    },
  });

  const imported = await target.upload(bytes);
  expect(imported.status).toBe(500);
  expect(target.latch.isClosed()).toBe(false);
  // And the live database is still the one that was there.
  expect((await target.call("GET", "/api/database")).status).toBe(200);

  source.cleanup();
  target.cleanup();
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

/**
 * The other end of the byte cap: what the disk can actually take.
 *
 * `createSnapshot` demands room before `VACUUM INTO` because filling the
 * filesystem the installation runs on is worse than a refused backup. The
 * import path is the one that accepts operator-supplied bytes and had no such
 * check at all, so it would stream up to two gibibytes into the installation
 * directory and find out afterwards — with the pre-restore snapshot, which
 * needs its own room, still to come.
 */
test("an import is refused before it writes when the disk could not hold it", async () => {
  const { upload, dir, cleanup } = await harness({ fs: { freeBytes: () => 1_000 } });

  const response = await upload(new Uint8Array(64_000));
  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
    "disk space",
  );
  expect(readdirSync(dir).filter((name) => name.endsWith(".part"))).toEqual([]);

  cleanup();
});

test("an import of unknown length stops at what is free rather than at the cap", async () => {
  // A chunked body declares no length, so the up-front check has nothing to
  // read and the budget has to be enforced on the bytes as they land.
  const { uploadStream, dir, cleanup } = await harness({ fs: { freeBytes: () => 0 } });

  const response = await uploadStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8_192));
        controller.close();
      },
    }),
  );

  expect(response.status).toBe(409);
  expect(readdirSync(dir).filter((name) => name.endsWith(".part"))).toEqual([]);

  cleanup();
});

test("an import proceeds when the filesystem will not say how much is free", async () => {
  const source = await harness();
  const created = await source.snapshot();
  const bytes = new Uint8Array(
    await Bun.file(join(source.dir, "snapshots", created.id)).arrayBuffer(),
  );

  // Null is "this filesystem will not say", which is not the same as "no room".
  const target = await harness({ fs: { freeBytes: () => null } });
  expect((await target.upload(bytes)).status).toBe(200);

  source.cleanup();
  target.cleanup();
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
    version: "1.2.3",
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
    ["DELETE", "/api/database/bodies"],
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
