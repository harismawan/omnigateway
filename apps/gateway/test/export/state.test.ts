import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresStore, deriveKey } from "@omni/store";
import { SQL } from "bun";
import { type CommitStep, createPostgresExportState } from "../../src/export/state/postgres.ts";
import {
  EXPORT_DB_FILENAME,
  exportDbPathFor,
  openSqliteExportState,
} from "../../src/export/state/sqlite.ts";
import {
  type CommitBound,
  CommitTimeoutError,
  type ExportStateStore,
  LAST_ERROR_MAX_CHARS,
  ORPHAN_KEEP_MS,
} from "../../src/export/state.ts";

/**
 * One contract, both impls: the SQLite `export.db` the worker opens beside the
 * main file, and the Postgres `export_state` table in the main database. The
 * Postgres half runs when `OMNI_TEST_DATABASE_URL` names a server and is
 * skipped, visibly, when it does not — the same gate as the store contract.
 */
type Backend = {
  name: "sqlite" | "postgres";
  fresh(): Promise<ExportStateStore>;
  /**
   * Holds the lock a commit to `generation` must wait for, from another
   * connection, until the returned release is called: a row lock (`SELECT …
   * FOR UPDATE`) on Postgres, the writer lock (`BEGIN IMMEDIATE`) on SQLite.
   */
  holdLock(generation: string): Promise<() => Promise<void>>;
};

const DAY = 24 * 60 * 60 * 1000;

/** A commit bound `ms` from now on the wall clock, optionally on a given signal. */
function within(ms: number, signal = new AbortController().signal): CommitBound {
  return { signal, deadlineAt: Date.now() + ms, now: Date.now };
}
const G = "11111111-1111-4111-8111-111111111111";
const H = "22222222-2222-4222-8222-222222222222";
const K = "33333333-3333-4333-8333-333333333333";

function forEachState(define: (backend: Backend) => void): void {
  const opened: ExportStateStore[] = [];
  afterEach(() => {
    for (const s of opened.splice(0)) s.close();
  });

  describe("sqlite", () => {
    const dirs: string[] = [];
    afterAll(async () => {
      for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    });
    let path = "";
    define({
      name: "sqlite",
      async fresh() {
        const dir = await mkdtemp(join(tmpdir(), "omni-export-state-"));
        dirs.push(dir);
        path = exportDbPathFor(join(dir, "omnigateway.db"));
        const s = openSqliteExportState(path);
        opened.push(s);
        return s;
      },
      async holdLock() {
        const other = new Database(path);
        other.run("BEGIN IMMEDIATE");
        return async () => {
          other.run("ROLLBACK");
          other.close();
        };
      },
    });
  });

  const url = process.env.OMNI_TEST_DATABASE_URL;
  if (url === undefined || url === "") {
    test.skip("postgres: OMNI_TEST_DATABASE_URL unset, export state suite not run", () => {});
    return;
  }

  describe("postgres", () => {
    const pools: SQL[] = [];
    afterEach(async () => {
      for (const pool of pools.splice(0)) await pool.close();
    });
    define({
      name: "postgres",
      async fresh() {
        const admin = new SQL({ url, max: 1 });
        try {
          await admin.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
        } finally {
          await admin.close();
        }
        // The main store migrates; the state store only ever receives a pool.
        const store = await createPostgresStore({
          url,
          encryptionKey: await deriveKey("test-encryption-key-0123456789"),
        });
        store.close();
        const pool = new SQL({ url, max: 2 });
        pools.push(pool);
        const s = createPostgresExportState(pool);
        opened.push(s);
        return s;
      },
      async holdLock(generation) {
        const other = new SQL({ url, max: 1 });
        const conn = await other.reserve();
        await conn.unsafe("BEGIN");
        await conn.unsafe("SELECT * FROM export_state WHERE generation = $1 FOR UPDATE", [
          generation,
        ]);
        return async () => {
          await conn.unsafe("ROLLBACK");
          conn.release();
          await other.close();
        };
      },
    });
  });
}

forEachState((backend) => {
  test("ensure inserts at (startAt, '') once and is a no-op afterwards", async () => {
    const s = await backend.fresh();
    await s.ensure(G, 1_000);
    const [row] = await s.list();
    expect(row).toEqual({
      generation: G,
      cursorAt: 1_000,
      cursorId: "",
      epoch: 0,
      lastSuccessAt: null,
      lastError: null,
      lastErrorAt: null,
      exportedTotal: 0,
      droppedTotal: 0,
      caughtUpThrough: 0,
      seenRetentionLoweredAt: 0,
      gapPossibleAt: null,
      skipRequestedAt: null,
      orphanedAt: null,
    });
    const { epoch } = (await s.claim(G)) ?? { epoch: -1 };
    expect(
      await s.commit(G, epoch, { cursorAt: 5_000, cursorId: "r9", seenRetentionLoweredAt: 0 }),
    ).toBe(true);
    await s.ensure(G, 0);
    const [after] = await s.list();
    expect([after?.cursorAt, after?.cursorId, after?.epoch]).toEqual([5_000, "r9", 1]);
  });

  test("claim increments the epoch each time and returns the state; missing is null", async () => {
    const s = await backend.fresh();
    expect(await s.claim(G)).toBeNull();
    await s.ensure(G, 7);
    const first = await s.claim(G);
    expect([first?.epoch, first?.cursorAt, first?.cursorId]).toEqual([1, 7, ""]);
    expect((await s.claim(G))?.epoch).toBe(2);
    expect((await s.list())[0]?.epoch).toBe(2);
  });

  test("concurrent claims each get a distinct epoch", async () => {
    const s = await backend.fresh();
    await s.ensure(G, 0);
    const epochs = await Promise.all(Array.from({ length: 6 }, () => s.claim(G)));
    expect(epochs.map((c) => c?.epoch).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("a commit under the current epoch moves the cursor and adds the counters", async () => {
    const s = await backend.fresh();
    await s.ensure(G, 0);
    const claim = await s.claim(G);
    const epoch = claim?.epoch ?? -1;
    expect(
      await s.commit(G, epoch, {
        cursorAt: 100,
        cursorId: "a",
        caughtUpThrough: 90,
        seenRetentionLoweredAt: 3,
        exportedDelta: 5,
        droppedDelta: 1,
        lastSuccessAt: 110,
      }),
    ).toBe(true);
    expect(
      await s.commit(G, epoch, {
        cursorAt: 200,
        cursorId: "b",
        seenRetentionLoweredAt: 3,
        exportedDelta: 7,
        droppedDelta: 2,
      }),
    ).toBe(true);
    const [row] = await s.list();
    expect(row).toMatchObject({
      cursorAt: 200,
      cursorId: "b",
      caughtUpThrough: 90,
      seenRetentionLoweredAt: 3,
      exportedTotal: 12,
      droppedTotal: 3,
      // An omitted `lastSuccessAt` keeps the stored one.
      lastSuccessAt: 110,
    });
  });

  test("a stale epoch's commit is rejected whole and never moves the cursor backwards", async () => {
    const s = await backend.fresh();
    await s.ensure(G, 0);
    const stalled = (await s.claim(G))?.epoch ?? -1;
    const holder = (await s.claim(G))?.epoch ?? -1;
    expect(
      await s.commit(G, holder, {
        cursorAt: 500,
        cursorId: "m",
        caughtUpThrough: 400,
        seenRetentionLoweredAt: 9,
        exportedDelta: 10,
        lastSuccessAt: 510,
      }),
    ).toBe(true);
    const before = await s.list();

    // The stalled holder wakes and commits what it sent: behind, and ahead.
    for (const cursorAt of [100, 900]) {
      expect(
        await s.commit(G, stalled, {
          cursorAt,
          cursorId: "z",
          caughtUpThrough: 950,
          seenRetentionLoweredAt: 20,
          exportedDelta: 3,
          droppedDelta: 4,
          lastSuccessAt: 999,
        }),
      ).toBe(false);
    }
    expect(await s.recordError(G, stalled, "stale", 999)).toBe(false);
    expect(await s.list()).toEqual(before);
  });

  test("a backwards cursor is rejected even under the current epoch; an equal one commits", async () => {
    const s = await backend.fresh();
    await s.ensure(G, 0);
    const epoch = (await s.claim(G))?.epoch ?? -1;
    await s.commit(G, epoch, { cursorAt: 500, cursorId: "m", seenRetentionLoweredAt: 0 });
    const before = await s.list();
    for (const [cursorAt, cursorId] of [
      [499, "z"],
      [500, "l"],
    ] as const) {
      expect(
        await s.commit(G, epoch, {
          cursorAt,
          cursorId,
          seenRetentionLoweredAt: 0,
          exportedDelta: 1,
        }),
      ).toBe(false);
    }
    expect(await s.list()).toEqual(before);

    // Same position: an idle pass recording that it is caught up.
    expect(
      await s.commit(G, epoch, {
        cursorAt: 500,
        cursorId: "m",
        caughtUpThrough: 600,
        seenRetentionLoweredAt: 0,
      }),
    ).toBe(true);
    // Same millisecond, later id: forward.
    expect(
      await s.commit(G, epoch, { cursorAt: 500, cursorId: "n", seenRetentionLoweredAt: 0 }),
    ).toBe(true);
    const [row] = await s.list();
    expect([row?.cursorAt, row?.cursorId, row?.caughtUpThrough]).toEqual([500, "n", 600]);
  });

  test("caughtUpThrough and seenRetentionLoweredAt never go backwards", async () => {
    const s = await backend.fresh();
    await s.ensure(G, 0);
    const epoch = (await s.claim(G))?.epoch ?? -1;
    await s.commit(G, epoch, {
      cursorAt: 1,
      cursorId: "",
      caughtUpThrough: 1_000,
      seenRetentionLoweredAt: 50,
    });
    expect(
      await s.commit(G, epoch, {
        cursorAt: 2,
        cursorId: "",
        caughtUpThrough: 10,
        seenRetentionLoweredAt: 5,
      }),
    ).toBe(true);
    const [row] = await s.list();
    expect([row?.cursorAt, row?.caughtUpThrough, row?.seenRetentionLoweredAt]).toEqual([
      2, 1_000, 50,
    ]);
  });

  test("a bounded commit blocked past its remaining time fails and leaves the row unchanged", async () => {
    const s = await backend.fresh();
    await s.ensure(G, 0);
    const { epoch } = (await s.claim(G)) ?? { epoch: -1 };
    const release = await backend.holdLock(G);
    const started = performance.now();
    try {
      await expect(
        s.commit(
          G,
          epoch,
          { cursorAt: 9, cursorId: "r1", seenRetentionLoweredAt: 0, exportedDelta: 1 },
          within(150),
        ),
      ).rejects.toBeInstanceOf(CommitTimeoutError);
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      await release();
    }
    const [row] = await s.list();
    expect([row?.cursorAt, row?.cursorId, row?.exportedTotal]).toEqual([0, "", 0]);
    // The bound is per commit: the next one, unblocked, lands.
    expect(
      await s.commit(
        G,
        epoch,
        { cursorAt: 9, cursorId: "r1", seenRetentionLoweredAt: 0, exportedDelta: 1 },
        within(5_000),
      ),
    ).toBe(true);
    expect((await s.list())[0]?.cursorId).toBe("r1");
  });

  test("a bounded commit with an aborted signal, or no time left, writes nothing", async () => {
    const s = await backend.fresh();
    await s.ensure(G, 0);
    const { epoch } = (await s.claim(G)) ?? { epoch: -1 };
    const aborted = new AbortController();
    aborted.abort(new Error("deadline"));
    const next = { cursorAt: 9, cursorId: "r1", seenRetentionLoweredAt: 0 };
    await expect(s.commit(G, epoch, next, within(5_000, aborted.signal))).rejects.toBeInstanceOf(
      CommitTimeoutError,
    );
    await expect(s.commit(G, epoch, next, within(0))).rejects.toBeInstanceOf(CommitTimeoutError);
    expect((await s.list())[0]?.cursorId).toBe("");
  });

  test("commit against an unknown generation is false", async () => {
    const s = await backend.fresh();
    expect(await s.commit(G, 1, { cursorAt: 1, cursorId: "", seenRetentionLoweredAt: 0 })).toBe(
      false,
    );
    expect(await s.recordError(G, 1, "x", 1)).toBe(false);
  });

  test("recordError is fenced and bounds the stored message", async () => {
    const s = await backend.fresh();
    await s.ensure(G, 0);
    const epoch = (await s.claim(G))?.epoch ?? -1;
    expect(await s.recordError(G, epoch, "elasticsearch: HTTP 400", 1_234)).toBe(true);
    let [row] = await s.list();
    expect([row?.lastError, row?.lastErrorAt]).toEqual(["elasticsearch: HTTP 400", 1_234]);

    expect(await s.recordError(G, epoch, "x".repeat(5_000), 2_000)).toBe(true);
    [row] = await s.list();
    expect(row?.lastError?.length).toBe(LAST_ERROR_MAX_CHARS);
    expect(LAST_ERROR_MAX_CHARS).toBe(200);

    // A cut never leaves half a surrogate pair behind.
    const emoji = `${"x".repeat(LAST_ERROR_MAX_CHARS - 1)}😀`;
    await s.recordError(G, epoch, emoji, 3_000);
    [row] = await s.list();
    expect(row?.lastError).toBe("x".repeat(LAST_ERROR_MAX_CHARS - 1));

    // A commit does not clear it: the console shows the last error beside the last success.
    await s.commit(G, epoch, {
      cursorAt: 1,
      cursorId: "",
      seenRetentionLoweredAt: 0,
      lastSuccessAt: 4_000,
    });
    [row] = await s.list();
    expect([row?.lastErrorAt, row?.lastSuccessAt]).toEqual([3_000, 4_000]);
  });

  test("flagGap sets once until cleared; unfenced; clearGap never clears a newer flag", async () => {
    const s = await backend.fresh();
    expect(await s.flagGap(G, 10)).toBe(false);
    await s.ensure(G, 0);
    expect(await s.flagGap(G, 100)).toBe(true);
    expect(await s.flagGap(G, 200)).toBe(false);
    expect((await s.list())[0]?.gapPossibleAt).toBe(100);

    // The operator acknowledged the flag they saw at 100, but one raised later survives.
    expect(await s.clearGap(G, 99)).toBe(false);
    expect((await s.list())[0]?.gapPossibleAt).toBe(100);
    expect(await s.clearGap(G, 100)).toBe(true);
    expect((await s.list())[0]?.gapPossibleAt).toBeNull();
    expect(await s.flagGap(G, 300)).toBe(true);
    expect((await s.list())[0]?.gapPossibleAt).toBe(300);
  });

  test("skip flag round trip: request, read, clear only what was applied", async () => {
    const s = await backend.fresh();
    expect(await s.requestSkip(G, 10)).toBe(false);
    await s.ensure(G, 0);
    expect(await s.requestSkip(G, 100)).toBe(true);
    expect((await s.list())[0]?.skipRequestedAt).toBe(100);

    // The worker applies the request it read (100); a second arrives meanwhile.
    expect(await s.requestSkip(G, 150)).toBe(true);
    expect(await s.clearSkip(G, 100)).toBe(false);
    expect((await s.list())[0]?.skipRequestedAt).toBe(150);
    expect(await s.clearSkip(G, 150)).toBe(true);
    expect((await s.list())[0]?.skipRequestedAt).toBeNull();

    // A late, older request never replaces a newer one.
    await s.requestSkip(G, 300);
    await s.requestSkip(G, 200);
    expect((await s.list())[0]?.skipRequestedAt).toBe(300);
  });

  test("list returns every row in generation order", async () => {
    const s = await backend.fresh();
    await s.ensure(K, 3);
    await s.ensure(G, 1);
    await s.ensure(H, 2);
    expect((await s.list()).map((r) => [r.generation, r.cursorAt])).toEqual([
      [G, 1],
      [H, 2],
      [K, 3],
    ]);
  });

  test("an orphaned row is kept for 7 days from when it was first seen orphaned", async () => {
    expect(ORPHAN_KEEP_MS).toBe(7 * DAY);
    const s = await backend.fresh();
    await s.ensure(G, 0);
    await s.ensure(H, 0);
    const t0 = 1_000_000;

    expect(await s.deleteOrphans([G], t0)).toBe(0);
    expect((await s.list()).map((r) => [r.generation, r.orphanedAt])).toEqual([
      [G, null],
      [H, t0],
    ]);
    // Seeing it again does not restart its clock.
    expect(await s.deleteOrphans([G], t0 + DAY)).toBe(0);
    expect((await s.list())[1]?.orphanedAt).toBe(t0);
    expect(await s.deleteOrphans([G], t0 + 7 * DAY - 1)).toBe(0);
    expect(await s.deleteOrphans([G], t0 + 7 * DAY)).toBe(1);
    expect((await s.list()).map((r) => r.generation)).toEqual([G]);
  });

  test("a row that reappears (a restore brought its destination back) loses its orphan clock", async () => {
    const s = await backend.fresh();
    await s.ensure(G, 0);
    const t0 = 5_000_000;
    await s.deleteOrphans([], t0);
    expect((await s.list())[0]?.orphanedAt).toBe(t0);
    await s.deleteOrphans([G], t0 + 6 * DAY);
    expect((await s.list())[0]?.orphanedAt).toBeNull();
    const t2 = t0 + 6 * DAY + 1;
    await s.deleteOrphans([], t2);
    expect(await s.deleteOrphans([], t0 + 7 * DAY)).toBe(0);
    expect(await s.deleteOrphans([], t2 + 7 * DAY - 1)).toBe(0);
    expect(await s.deleteOrphans([], t2 + 7 * DAY)).toBe(1);
    expect(await s.list()).toEqual([]);
  });

  test("deleteOrphans honours an explicit keep period", async () => {
    const s = await backend.fresh();
    await s.ensure(G, 0);
    await s.deleteOrphans([], 0, 10);
    expect(await s.deleteOrphans([], 9, 10)).toBe(0);
    expect(await s.deleteOrphans([], 10, 10)).toBe(1);
  });
});

describe("sqlite export.db", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  test("lives beside the main file as export.db, in WAL mode, and survives a reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-export-state-"));
    dirs.push(dir);
    const path = exportDbPathFor(join(dir, "omnigateway.db"));
    expect(EXPORT_DB_FILENAME).toBe("export.db");
    expect(path).toBe(join(dir, "export.db"));

    const first = openSqliteExportState(path);
    await first.ensure(G, 42);
    await first.claim(G);
    first.close();
    // Closing twice is harmless: pause closes every handle, and stop may follow.
    first.close();

    const again = openSqliteExportState(path);
    try {
      expect((await again.list()).map((r) => [r.generation, r.cursorAt, r.epoch])).toEqual([
        [G, 42, 1],
      ]);
    } finally {
      again.close();
    }

    const raw = new Database(path, { readonly: true });
    try {
      expect(
        raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
      ).toBe("wal");
      expect(
        raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      ).toBe(1);
    } finally {
      raw.close();
    }
  });
});

const pg = process.env.OMNI_TEST_DATABASE_URL;
if (pg !== undefined && pg !== "") {
  test("postgres: state writes never move config_version", async () => {
    const admin = new SQL({ url: pg, max: 1 });
    try {
      await admin.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    } finally {
      await admin.close();
    }
    const store = await createPostgresStore({
      url: pg,
      encryptionKey: await deriveKey("test-encryption-key-0123456789"),
    });
    store.close();
    const pool = new SQL({ url: pg, max: 2 });
    try {
      const version = async (): Promise<string> =>
        String(
          (await pool.unsafe<Array<{ version: string }>>("SELECT version FROM config_version"))[0]
            ?.version,
        );
      const before = await version();
      const s = createPostgresExportState(pool);
      await s.ensure(G, 0);
      const epoch = (await s.claim(G))?.epoch ?? -1;
      await s.commit(G, epoch, {
        cursorAt: 1,
        cursorId: "a",
        seenRetentionLoweredAt: 0,
        exportedDelta: 1,
      });
      await s.recordError(G, epoch, "x", 1);
      await s.flagGap(G, 1);
      await s.requestSkip(G, 1);
      await s.clearSkip(G, 1);
      await s.deleteOrphans([], 1);
      s.close();
      expect(await version()).toBe(before);
    } finally {
      await pool.close();
    }
  });
}

/**
 * The Postgres bounded commit, phase by phase: a commit that has not completed
 * in the database by its deadline never takes effect, whether the deadline
 * passes while it waits for a connection, during its setup, while its UPDATE
 * waits on a row lock, or just before COMMIT.
 */
if (pg !== undefined && pg !== "") {
  describe("postgres bounded commit", () => {
    const pools: SQL[] = [];
    afterEach(async () => {
      for (const pool of pools.splice(0)) await pool.close();
    });

    async function setup(max: number) {
      const admin = new SQL({ url: pg, max: 1 });
      try {
        await admin.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      } finally {
        await admin.close();
      }
      const store = await createPostgresStore({
        url: pg as string,
        encryptionKey: await deriveKey("test-encryption-key-0123456789"),
      });
      store.close();
      const pool = new SQL({ url: pg, max });
      pools.push(pool);
      // What reached the server, in order.
      const steps: CommitStep[] = [];
      let hook: (step: CommitStep) => Promise<void> = async () => {};
      const s = createPostgresExportState(pool, {
        beforeStatement: (step) => hook(step),
        sent: (step) => steps.push(step),
      });
      await s.ensure(G, 0);
      const { epoch } = (await s.claim(G)) ?? { epoch: -1 };
      steps.length = 0;
      return {
        s,
        pool,
        epoch,
        steps,
        setHook(next: (step: CommitStep) => Promise<void>) {
          hook = next;
        },
      };
    }
    const next = { cursorAt: 9, cursorId: "r1", seenRetentionLoweredAt: 0, exportedDelta: 1 };
    const unchanged = async (s: ExportStateStore) => {
      const [row] = await s.list();
      expect([row?.cursorAt, row?.cursorId, row?.exportedTotal]).toEqual([0, "", 0]);
    };

    test("the normal path runs begin, one setup, the update and commit, and lands", async () => {
      const { s, epoch, steps } = await setup(2);
      expect(await s.commit(G, epoch, next, within(5_000))).toBe(true);
      expect(steps).toEqual(["begin", "setup", "update", "commit"]);
      expect((await s.list())[0]?.cursorId).toBe("r1");
    });

    test("expiry while waiting for a connection rejects in time; the late connection writes nothing", async () => {
      const { s, pool, epoch, steps } = await setup(1);
      const held = await pool.reserve();
      const started = performance.now();
      try {
        await expect(s.commit(G, epoch, next, within(150))).rejects.toBeInstanceOf(
          CommitTimeoutError,
        );
        expect(performance.now() - started).toBeLessThan(1_000);
      } finally {
        held.release();
      }
      // The connection the commit asked for arrives now; it must be handed back unused.
      await Bun.sleep(200);
      expect(steps).toEqual([]);
      await unchanged(s);
      // And the pool is not leaked: the next commit gets that connection.
      expect(await s.commit(G, epoch, next, within(5_000))).toBe(true);
    });

    test("expiry during setup issues no update and rolls back", async () => {
      const { s, epoch, steps, setHook } = await setup(2);
      const controller = new AbortController();
      setHook(async (step) => {
        // The deadline passes while the setup statement is on the wire (or,
        // on a fast loopback, just after it answered). The update's hook gives
        // the timer room to fire either way: the check made after the hook,
        // immediately before sending, is what must refuse the UPDATE.
        if (step === "setup") setTimeout(() => controller.abort(new Error("deadline")), 0);
        if (step === "update") await Bun.sleep(20);
      });
      await expect(
        s.commit(G, epoch, next, within(5_000, controller.signal)),
      ).rejects.toBeInstanceOf(CommitTimeoutError);
      expect(controller.signal.aborted).toBe(true);
      expect(steps).toEqual(["begin", "setup"]);
      await unchanged(s);
    });

    test("expiry during an update blocked on a row lock cancels it; the row is unchanged", async () => {
      const { s, epoch, steps } = await setup(2);
      const other = new SQL({ url: pg, max: 1 });
      const lock = await other.reserve();
      await lock.unsafe("BEGIN");
      await lock.unsafe("SELECT * FROM export_state WHERE generation = $1 FOR UPDATE", [G]);
      // The database's own timeouts would wait 5 s; the signal fires at 150 ms
      // and must cancel the statement in flight.
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("deadline")), 150);
      const started = performance.now();
      try {
        await expect(
          s.commit(G, epoch, next, within(5_000, controller.signal)),
        ).rejects.toBeInstanceOf(CommitTimeoutError);
        expect(performance.now() - started).toBeLessThan(2_000);
        // Sent, blocked, cancelled: no COMMIT followed it.
        expect(steps).toEqual(["begin", "setup", "update"]);
      } finally {
        await lock.unsafe("ROLLBACK");
        lock.release();
        await other.close();
      }
      await unchanged(s);
    });

    test("a deadline passing just before COMMIT rolls the transaction back", async () => {
      const { s, epoch, steps, setHook } = await setup(2);
      const controller = new AbortController();
      setHook(async (step) => {
        if (step === "commit") controller.abort(new Error("deadline"));
      });
      await expect(
        s.commit(G, epoch, next, within(5_000, controller.signal)),
      ).rejects.toBeInstanceOf(CommitTimeoutError);
      // The update ran; COMMIT was never sent, so it rolled back.
      expect(steps).toEqual(["begin", "setup", "update"]);
      await unchanged(s);
    });

    test("the remaining time is recomputed from the deadline at each statement", async () => {
      const { s, epoch, steps, setHook } = await setup(2);
      // Each statement's check reads the clock afresh: a clock that passes the
      // deadline after setup stops the update without any signal firing.
      let now = 1_000;
      const bound: CommitBound = {
        signal: new AbortController().signal,
        deadlineAt: 2_000,
        now: () => now,
      };
      setHook(async (step) => {
        if (step === "update") now = 2_000;
      });
      await expect(s.commit(G, epoch, next, bound)).rejects.toBeInstanceOf(CommitTimeoutError);
      expect(steps).toEqual(["begin", "setup"]);
      await unchanged(s);
    });
  });
}
