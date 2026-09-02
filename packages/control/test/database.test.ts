import { describe, expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { type DatabaseInspection, DEFAULT_SETTINGS, type Settings } from "@omni/store";
import { type CaptureLogger, captureLogger } from "@omni/testkit";
import {
  createSnapshot,
  type DatabaseDeps,
  deleteSnapshot,
  getDatabaseOverview,
  importSnapshot,
  listSnapshots,
  MAX_IMPORT_BYTES,
  previewRestore,
  pruneSnapshots,
  putRetention,
  resolveSnapshotForDownload,
  restoreSnapshot,
  SwapFailedError,
  sweepStaging,
  vacuum,
} from "../src/database.ts";

const DB = "/srv/omni/omnigateway.db";
const SNAPSHOTS = "/srv/omni/snapshots";
const AT = Date.parse("2026-08-18T04:12:03.114Z");

type Fake = DatabaseDeps & {
  /** Every path that exists, with its size. The whole filesystem for a test. */
  files: Map<string, number>;
  /** What happened, in order. Restore is an ordering contract, so order is asserted. */
  log: string[];
  settings: Settings;
  logger: CaptureLogger;
};

/**
 * A database panel over a fake filesystem and a fake store.
 *
 * Mirrors `console.test.ts`: every effect is a recorded closure over a plain
 * map, so no test creates a directory, spawns anything, or opens SQLite.
 */
function deps(
  input: {
    files?: Record<string, number>;
    settings?: Partial<Settings>;
    now?: number;
    freeBytes?: number | null;
    inspect?: DatabaseInspection;
    /**
     * Inspections keyed by the path asked about, for the callers that ask twice.
     *
     * A preview compares two files, and a fixture that answered both with one
     * object would pass with the columns swapped — which is the mistake worth
     * catching, because "snapshot" and "live" are the two words the operator
     * reads the table by.
     */
    inspectBy?: Record<string, DatabaseInspection>;
    /** Runs inside `inspect`, so a test can hold an operation open mid-flight. */
    onInspect?: (path: string) => Promise<void>;
    /**
     * The admin password hash before the swap and after the reopen.
     *
     * Two values rather than one because the whole question a restore has to
     * answer is whether the file it swapped in carries a different one. Equal
     * unless a test says otherwise.
     */
    adminHash?: { before: string | null; after: string | null };
    viewerHash?: { before: string | null; after: string | null };
    /**
     * A rollup rebuild that throws, which is the one step of a restore that is
     * allowed to fail after the swap has already succeeded.
     */
    rebuildFails?: boolean;
  } = {},
): Fake {
  const files = new Map<string, number>(Object.entries(input.files ?? { [DB]: 4_096 }));
  const log: string[] = [];
  const logger = captureLogger();
  const settings: Settings = { ...DEFAULT_SETTINGS, ...input.settings };
  const adminHash = input.adminHash ?? {
    before: "argon2-of-the-same",
    after: "argon2-of-the-same",
  };
  const viewerHash = input.viewerHash ?? { before: null, after: null };
  let liveAdminHash = adminHash.before;
  let liveViewerHash = viewerHash.before;

  return {
    files,
    log,
    settings,
    logger,
    now: () => input.now ?? AT,
    store: {
      databasePath: DB,
      config: {
        getSettings: async () => settings,
        putSettings: async (patch) => Object.assign(settings, patch),
        getAdminPasswordHash: async () => liveAdminHash,
        getViewerPasswordHash: async () => liveViewerHash,
      },
      maintenance: {
        heartbeat: async () => {},
        stats: async () => ({
          pageSize: 4_096,
          pageCount: 100,
          freelistCount: 10,
          schemaVersion: 7,
        }),
        vacuum: async () => {
          log.push("vacuum");
        },
        snapshotTo: async (path) => {
          log.push(`snapshotTo:${path}`);
          files.set(path, 2_048);
        },
        inspect: async (path) => {
          log.push(`inspect:${path}`);
          await input.onInspect?.(path);
          return (
            input.inspectBy?.[path] ??
            input.inspect ?? { ok: true, quickCheck: "ok", tables: [], counts: { settings: 1 } }
          );
        },
      },
      usage: {
        rebuildRollup: async () => {
          log.push("rebuildRollup");
          if (input.rebuildFails === true) throw new Error("no space left on device");
        },
      },
      close: () => log.push("close"),
      reopen: async () => {
        log.push("reopen");
        // The file underneath changed; so, possibly, did the credential in it.
        liveAdminHash = adminHash.after;
        liveViewerHash = viewerHash.after;
      },
    },
    fs: {
      readdir: (dir) =>
        [...files.keys()]
          .filter((path) => path.startsWith(`${dir}/`))
          .map((path) => path.slice(dir.length + 1)),
      stat: (path) => {
        const size = files.get(path);
        return size === undefined ? null : { size, mtimeMs: AT };
      },
      unlink: (path) => {
        log.push(`unlink:${path}`);
        files.delete(path);
      },
      rename: (from, to) => {
        log.push(`rename:${from}->${to}`);
        const size = files.get(from);
        if (size !== undefined) {
          files.delete(from);
          files.set(to, size);
        }
      },
      copyFile: (from, to) => {
        log.push(`copyFile:${from}->${to}`);
        files.set(to, files.get(from) ?? 0);
      },
      mkdir: (dir) => log.push(`mkdir:${dir}`),
      // No links unless a test says so; a path that exists resolves to itself.
      realpath: (path) => (files.has(path) ? path : null),
      freeBytes: () => (input.freeBytes === undefined ? 10 ** 12 : input.freeBytes),
      dirBytes: () => 0,
    },
  };
}

describe("createSnapshot", () => {
  test("names a snapshot after the instant it was taken and the reason it was taken", async () => {
    const d = deps();
    const info = await createSnapshot(d, { reason: "manual" });
    expect(info.filename).toBe("db_2026-08-18T04-12-03-114Z_manual.sqlite");
    expect(info.id).toBe(info.filename);
    expect(info.createdAt).toBe(AT);
    expect(d.log).toContain(`snapshotTo:${SNAPSHOTS}/${info.filename}`);
  });
});

describe("listSnapshots", () => {
  const dir = {
    [DB]: 4_096,
    [`${SNAPSHOTS}/db_2026-08-17T04-12-03-114Z_manual.sqlite`]: 100,
    [`${SNAPSHOTS}/db_2026-08-18T04-12-03-114Z_preRestore.sqlite`]: 200,
  };

  test("reads the instant and the reason back out of the name, newest first", () => {
    const listed = listSnapshots(deps({ files: dir }));
    expect(listed.map((s) => s.reason)).toEqual(["preRestore", "manual"]);
    expect(listed[0]?.createdAt).toBe(AT);
    expect(listed[0]?.sizeBytes).toBe(200);
  });

  test("ignores anything in the directory that is not one of ours", () => {
    // An operator's own copy, a partial write, a stray `-wal`: the directory is
    // on disk and anything can be in it, so the name is the membership test.
    const listed = listSnapshots(
      deps({
        files: {
          ...dir,
          [`${SNAPSHOTS}/notes.txt`]: 10,
          [`${SNAPSHOTS}/db_2026-08-18T04-12-03-114Z_manual.sqlite.tmp`]: 10,
          [`${SNAPSHOTS}/backup.sqlite`]: 10,
        },
      }),
    );
    expect(listed).toHaveLength(2);
  });

  test("reads an absent snapshots directory as no snapshots", () => {
    expect(listSnapshots(deps())).toEqual([]);
  });
});

/** Ids that must never resolve to a path, whatever else is true. */
const HOSTILE_IDS = [
  "../omnigateway.db",
  "../../etc/passwd",
  "snapshots/../../omnigateway.db",
  "/etc/passwd",
  "db_2026-08-18T04-12-03-114Z_manual.sqlite/../../omnigateway.db",
  "",
  "..",
  ".",
];

describe("snapshot ids are a closed pattern, not a path", () => {
  const existing = `db_2026-08-18T04-12-03-114Z_manual.sqlite`;
  const files = { [DB]: 4_096, [`${SNAPSHOTS}/${existing}`]: 200 };

  test.each(HOSTILE_IDS)("refuses to resolve %p for download", (id) => {
    expect(() => resolveSnapshotForDownload(deps({ files }), id)).toThrow(GatewayError);
  });

  test.each(HOSTILE_IDS)("refuses to delete %p", (id) => {
    const d = deps({ files });
    expect(() => deleteSnapshot(d, id)).toThrow(GatewayError);
    // The live database is the thing on the other end of `..`, so its survival
    // is the assertion that matters.
    expect(d.files.has(DB)).toBe(true);
    expect(d.log).toEqual([]);
  });

  test("resolves a real id to a file inside the snapshots directory", () => {
    const resolved = resolveSnapshotForDownload(deps({ files }), existing);
    expect(resolved).toEqual({
      path: `${SNAPSHOTS}/${existing}`,
      filename: existing,
      sizeBytes: 200,
    });
  });

  test("reports a well-formed id that is not on disk rather than handing back a path", () => {
    const missing = "db_2020-01-01T00-00-00-000Z_manual.sqlite";
    expect(() => resolveSnapshotForDownload(deps({ files }), missing)).toThrow(GatewayError);
  });

  /**
   * The check the pattern and the lexical containment both pass.
   *
   * `resolve` collapses `..` and nothing else, so a symlink inside the
   * snapshots directory names a path that is textually contained and really is
   * not — and the live database is one link away. Reaching this needs local
   * write access to the installation directory, but the guard is the one thing
   * standing between a caller-supplied id and `unlink`, so it resolves what the
   * filesystem would resolve rather than what the string looks like.
   */
  test("refuses an id whose file is a symlink pointing out of the directory", () => {
    const d = deps({ files });
    d.fs.realpath = (path) => (path === `${SNAPSHOTS}/${existing}` ? DB : path);

    expect(() => resolveSnapshotForDownload(d, existing)).toThrow(GatewayError);
    expect(() => deleteSnapshot(d, existing)).toThrow(GatewayError);
    expect(d.files.has(DB)).toBe(true);
    expect(d.log).toEqual([]);
  });

  test("allows a snapshots directory that is itself a symlink", () => {
    // Containment is against where the directory really is, not where it is
    // spelled: an operator who points `snapshots/` at another volume has not
    // done anything wrong.
    const d = deps({ files });
    d.fs.realpath = (path) =>
      path === SNAPSHOTS
        ? "/mnt/backups"
        : path === `${SNAPSHOTS}/${existing}`
          ? `/mnt/backups/${existing}`
          : path;

    expect(resolveSnapshotForDownload(d, existing).path).toBe(`${SNAPSHOTS}/${existing}`);
  });

  test("deletes a real snapshot and nothing else", () => {
    const d = deps({ files });
    deleteSnapshot(d, existing);
    expect(d.files.has(`${SNAPSHOTS}/${existing}`)).toBe(false);
    expect(d.files.has(DB)).toBe(true);
  });
});

const DAY = 86_400_000;

/** A snapshot filename for an instant, as `createSnapshot` would have named it. */
function name(at: number, reason = "manual"): string {
  return `db_${new Date(at).toISOString().replaceAll(":", "-").replaceAll(".", "-")}_${reason}.sqlite`;
}

describe("retention runs after a create", () => {
  const older = {
    [DB]: 4_096,
    [`${SNAPSHOTS}/${name(AT - 3 * DAY)}`]: 100,
    [`${SNAPSHOTS}/${name(AT - 2 * DAY)}`]: 100,
    [`${SNAPSHOTS}/${name(AT - 1 * DAY)}`]: 100,
  };

  test("keeps only the newest `keepLatest`, counting the one just taken", async () => {
    const d = deps({ files: older, settings: { snapshotKeepLatest: 2, snapshotMaxAgeDays: 365 } });
    await createSnapshot(d, { reason: "manual" });
    expect(listSnapshots(d).map((s) => s.createdAt)).toEqual([AT, AT - DAY]);
  });

  test("drops anything older than `maxAgeDays` even when the count is under the cap", async () => {
    const d = deps({ files: older, settings: { snapshotKeepLatest: 50, snapshotMaxAgeDays: 2 } });
    await createSnapshot(d, { reason: "manual" });
    expect(listSnapshots(d).map((s) => s.createdAt)).toEqual([AT, AT - DAY, AT - 2 * DAY]);
  });

  test("never deletes the newest snapshot, whatever the policy says", async () => {
    // A policy tight enough to delete everything would otherwise leave an
    // installation with no undo at all, which is the one state retention exists
    // to avoid.
    const d = deps({
      files: older,
      settings: { snapshotKeepLatest: 1, snapshotMaxAgeDays: 1 },
      now: AT + 10 * DAY,
    });
    const info = await createSnapshot(d, { reason: "manual" });
    expect(listSnapshots(d).map((s) => s.id)).toEqual([info.id]);
  });

  test("a forced snapshot skips retention, so the undo survives the policy it precedes", async () => {
    const d = deps({ files: older, settings: { snapshotKeepLatest: 1, snapshotMaxAgeDays: 1 } });
    await createSnapshot(d, { reason: "preRestore", force: true });
    expect(listSnapshots(d)).toHaveLength(4);
  });

  /**
   * The undo has to survive the *next* policy run too, not only its own.
   *
   * `force` skips retention while the pre-restore snapshot is being written and
   * nothing after that treats it differently, so at the default `keepLatest` a
   * handful of manual snapshots is enough to delete the only way back from a
   * restore taken minutes earlier. It is described everywhere as the recovery
   * path; ordinary housekeeping must not be what removes it.
   */
  test("the newest pre-restore snapshot survives later retention runs", async () => {
    const undo = name(AT - 5 * DAY, "preRestore");
    const d = deps({
      files: {
        [DB]: 4_096,
        [`${SNAPSHOTS}/${undo}`]: 100,
        [`${SNAPSHOTS}/${name(AT - 4 * DAY)}`]: 100,
        [`${SNAPSHOTS}/${name(AT - 3 * DAY)}`]: 100,
        [`${SNAPSHOTS}/${name(AT - 2 * DAY)}`]: 100,
      },
      settings: { snapshotKeepLatest: 2, snapshotMaxAgeDays: 1 },
    });

    await createSnapshot(d, { reason: "manual" });

    const kept = listSnapshots(d).map((s) => s.id);
    expect(kept).toContain(undo);
    // And it is an exemption rather than a reprieve for everything: every
    // manual copy past the policy is still gone, age bound included.
    expect(kept).toEqual([name(AT), undo]);
  });

  test("exempts only the newest pre-restore snapshot, not every one ever taken", async () => {
    const newer = name(AT - 1 * DAY, "preRestore");
    const older = name(AT - 9 * DAY, "preRestore");
    const d = deps({
      files: { [DB]: 4_096, [`${SNAPSHOTS}/${newer}`]: 100, [`${SNAPSHOTS}/${older}`]: 100 },
      settings: { snapshotKeepLatest: 1, snapshotMaxAgeDays: 2 },
    });

    await createSnapshot(d, { reason: "manual" });
    expect(listSnapshots(d).map((s) => s.id)).toEqual([name(AT), newer]);
  });
});

/**
 * Retention on a schedule, which is the only way either bound ever fires on an
 * installation that has stopped taking snapshots.
 *
 * `maxAgeDays` expires nothing and a lowered `keepLatest` prunes nothing while
 * the only caller of retention is the create path, so the policy an operator
 * saved is a policy that never runs. The dashboard tells them it runs on the
 * hourly sweep; this is that.
 */
describe("pruneSnapshots", () => {
  const older = {
    [DB]: 4_096,
    [`${SNAPSHOTS}/${name(AT - 3 * DAY)}`]: 100,
    [`${SNAPSHOTS}/${name(AT - 2 * DAY)}`]: 100,
    [`${SNAPSHOTS}/${name(AT - 1 * DAY)}`]: 100,
  };

  test("applies the count bound without waiting for a create", async () => {
    const d = deps({ files: older, settings: { snapshotKeepLatest: 2, snapshotMaxAgeDays: 365 } });
    expect(await pruneSnapshots(d)).toBe(1);
    expect(listSnapshots(d).map((s) => s.createdAt)).toEqual([AT - DAY, AT - 2 * DAY]);
  });

  test("applies the age bound without waiting for a create", async () => {
    const d = deps({
      files: older,
      settings: { snapshotKeepLatest: 50, snapshotMaxAgeDays: 2 },
      now: AT,
    });
    expect(await pruneSnapshots(d)).toBe(1);
    expect(listSnapshots(d).map((s) => s.createdAt)).toEqual([AT - DAY, AT - 2 * DAY]);
  });

  test("steps aside rather than failing when an operation holds the database", async () => {
    // Hourly, and with nothing to say about a restore in progress. An error
    // line every time the two coincided would be noise about a condition that
    // resolves itself before the next tick.
    const d = deps({ files: older, settings: { snapshotKeepLatest: 1, snapshotMaxAgeDays: 365 } });
    let release = () => {};
    d.store.maintenance.vacuum = () => new Promise<void>((resolve) => (release = resolve));

    const running = vacuum(d);
    expect(await pruneSnapshots(d)).toBe(0);
    expect(listSnapshots(d)).toHaveLength(3);

    release();
    await running;
  });
});

/**
 * The files an interrupted operation leaves beside the database.
 *
 * A refused import leaves its upload, and a failed swap after the rename leaves
 * `${db}.incoming`. Both are database-sized and nothing else sweeps the
 * installation directory, so they go on the same tick as everything else.
 */
describe("sweepStaging", () => {
  const HOUR = 3_600_000;
  const staged = `${DB.slice(0, DB.lastIndexOf("/"))}/omni-import-abc123.sqlite.part`;

  test("removes an upload and an incoming file nothing has touched for an hour", () => {
    const d = deps({
      files: { [DB]: 4_096, [staged]: 900, [`${DB}.incoming`]: 2_000 },
      now: AT + 2 * HOUR,
    });
    expect(sweepStaging(d)).toBe(2);
    expect(d.files.has(staged)).toBe(false);
    expect(d.files.has(`${DB}.incoming`)).toBe(false);
  });

  test("leaves a staging file an upload could still be writing into", () => {
    // The mtime is the signal and not the name: a 2 GiB import over a slow link
    // is still being written to, and sweeping it out from under the request
    // that is streaming it would be the sweep causing the failure.
    const d = deps({ files: { [DB]: 4_096, [staged]: 900 }, now: AT + 60_000 });
    expect(sweepStaging(d)).toBe(0);
    expect(d.files.has(staged)).toBe(true);
  });

  test("never takes the live database, its journal, or anything in snapshots", () => {
    const d = deps({
      files: {
        [DB]: 4_096,
        [`${DB}-wal`]: 900,
        [`${DB}-shm`]: 32,
        [`${SNAPSHOTS}/${name(AT - DAY)}`]: 100,
      },
      now: AT + 100 * DAY,
    });
    expect(sweepStaging(d)).toBe(0);
    expect(d.log).toEqual([]);
    expect([...d.files.keys()].sort()).toEqual(
      [DB, `${DB}-wal`, `${DB}-shm`, `${SNAPSHOTS}/${name(AT - DAY)}`].sort(),
    );
  });
});

describe("createSnapshot guards the disk", () => {
  test("refuses when there is not enough free space for the copy", async () => {
    const d = deps({ files: { [DB]: 10_000_000 }, freeBytes: 1_000 });
    expect(createSnapshot(d, { reason: "manual" })).rejects.toThrow(GatewayError);
    expect(d.log.some((entry) => entry.startsWith("snapshotTo"))).toBe(false);
  });

  test("proceeds when free space cannot be read, rather than refusing on ignorance", async () => {
    const d = deps({ freeBytes: null });
    await createSnapshot(d, { reason: "manual" });
    expect(d.log.some((entry) => entry.startsWith("snapshotTo"))).toBe(true);
  });

  test("removes the partial file a failed VACUUM INTO leaves behind", async () => {
    const d = deps();
    d.store.maintenance.snapshotTo = async (path) => {
      d.files.set(path, 17);
      throw new Error("disk full");
    };
    expect(createSnapshot(d, { reason: "manual" })).rejects.toThrow();
    await Bun.sleep(0);
    expect(listSnapshots(d)).toEqual([]);
  });

  test("refuses to overwrite a snapshot taken in the same millisecond", async () => {
    const d = deps({ files: { [DB]: 4_096, [`${SNAPSHOTS}/${name(AT)}`]: 100 } });
    expect(createSnapshot(d, { reason: "manual" })).rejects.toThrow(GatewayError);
  });
});

describe("restoreSnapshot", () => {
  const id = name(AT - DAY);
  const files = { [DB]: 4_096, [`${SNAPSHOTS}/${id}`]: 2_000, [`${DB}-wal`]: 900 };

  test("validates, takes the undo, and only then closes and swaps — in that order", async () => {
    const d = deps({ files });
    await restoreSnapshot(d, id);
    expect(d.log).toEqual([
      `inspect:${SNAPSHOTS}/${id}`,
      `mkdir:${SNAPSHOTS}`,
      `snapshotTo:${SNAPSHOTS}/${name(AT, "preRestore")}`,
      `copyFile:${SNAPSHOTS}/${id}->${DB}.incoming`,
      "close",
      `unlink:${DB}-wal`,
      `unlink:${DB}-shm`,
      `rename:${DB}.incoming->${DB}`,
      "reopen",
      // After the reopen, never before: the rollup is derived from the rows in
      // whichever file is now live, and a rebuild against the outgoing handle
      // would summarize the database being replaced.
      "rebuildRollup",
    ]);
  });

  test("reports the pre-restore snapshot, which is the only undo there is", async () => {
    const d = deps({ files });
    const result = await restoreSnapshot(d, id);
    expect(result.preRestoreSnapshot.reason).toBe("preRestore");
    expect(d.files.has(`${SNAPSHOTS}/${result.preRestoreSnapshot.id}`)).toBe(true);
    expect(result.counts).toEqual({ settings: 1 });
  });

  test("leaves the restored snapshot on disk, so the same one can be used twice", async () => {
    const d = deps({ files });
    await restoreSnapshot(d, id);
    expect(d.files.has(`${SNAPSHOTS}/${id}`)).toBe(true);
  });

  test("refuses a file that fails quick_check, and never closes the database", async () => {
    const d = deps({
      files,
      inspect: {
        ok: false,
        quickCheck: "database disk image is malformed",
        tables: [],
        counts: {},
      },
    });
    expect(restoreSnapshot(d, id)).rejects.toThrow(GatewayError);
    await Bun.sleep(0);
    expect(d.log).toEqual([`inspect:${SNAPSHOTS}/${id}`]);
    expect(d.files.get(DB)).toBe(4_096);
  });

  test("refuses a foreign database that passes integrity but is not ours", async () => {
    const d = deps({
      files,
      inspect: { ok: false, quickCheck: "ok", tables: ["users"], counts: {} },
    });
    expect(restoreSnapshot(d, id)).rejects.toThrow(GatewayError);
    await Bun.sleep(0);
    expect(d.log).toEqual([`inspect:${SNAPSHOTS}/${id}`]);
  });

  /**
   * "Not one of ours" alone does not tell an operator which file they picked.
   *
   * The likely mistake is the wrong database from the right host, and `inspect`
   * already reads the table list to decide `ok` — so the refusal says what it
   * found rather than making them go and look. Schema identifiers only, from a
   * file an authenticated admin supplied, and bounded so a database with two
   * hundred tables does not become a two hundred item error message.
   */
  test("names what a foreign database holds, so the wrong file is recognisable", async () => {
    const d = deps({
      files,
      inspect: { ok: false, quickCheck: "ok", tables: ["orders", "products", "users"], counts: {} },
    });

    const error = await restoreSnapshot(d, id).catch((thrown: unknown) => thrown);
    expect((error as GatewayError).message).toContain("orders, products, users");
  });

  test("bounds the table list rather than printing a whole schema", async () => {
    const tables = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const d = deps({ files, inspect: { ok: false, quickCheck: "ok", tables, counts: {} } });

    const error = await restoreSnapshot(d, id).catch((thrown: unknown) => thrown);
    const message = (error as GatewayError).message;
    expect(message).toContain("t0, t1, t2, t3, t4 and 25 more");
    expect(message).not.toContain("t6");
  });

  test("says so plainly when a candidate has no tables at all", async () => {
    const d = deps({ files, inspect: { ok: false, quickCheck: "ok", tables: [], counts: {} } });

    const error = await restoreSnapshot(d, id).catch((thrown: unknown) => thrown);
    expect((error as GatewayError).message).toContain("no tables at all");
  });

  test("rejects a traversing id before it inspects, snapshots, or closes anything", async () => {
    const d = deps({ files });
    expect(restoreSnapshot(d, "../omnigateway.db")).rejects.toThrow(GatewayError);
    await Bun.sleep(0);
    expect(d.log).toEqual([]);
  });

  test("reports an admin password hash that the restored file changed", async () => {
    const d = deps({ files, adminHash: { before: "argon2-of-old", after: "argon2-of-new" } });
    const result = await restoreSnapshot(d, id);
    expect(result.adminPasswordChanged).toBe(true);
  });

  test("reports no change when the restored file carries the same admin password", async () => {
    // The point of comparing rather than assuming. A snapshot of this same
    // installation is the ordinary case, and it must not log the operator out
    // in the middle of the operation they are watching.
    const d = deps({ files, adminHash: { before: "argon2-of-one", after: "argon2-of-one" } });
    const result = await restoreSnapshot(d, id);
    expect(result.adminPasswordChanged).toBe(false);
  });

  test("counts either null transition as a change, in both directions", async () => {
    const gained = deps({ files, adminHash: { before: null, after: "argon2-of-new" } });
    expect((await restoreSnapshot(gained, id)).adminPasswordChanged).toBe(true);

    const lost = deps({ files, adminHash: { before: "argon2-of-old", after: null } });
    expect((await restoreSnapshot(lost, id)).adminPasswordChanged).toBe(true);
  });

  /**
   * The read-only password is a second way into a read of the whole
   * installation, and a restore can replace it without going through
   * `setViewerPassword`.
   *
   * This shipped comparing the admin hash alone. A database restored with a
   * different viewer password — or with none, which is every backup taken
   * before the feature existed — left live viewer sessions reading the new
   * database against a credential it does not contain. Withdrawing read-only
   * access by restoring an older backup did not withdraw it.
   */
  test("reports a changed viewer password independently of the admin one", async () => {
    const d = deps({
      files,
      adminHash: { before: "argon2-of-one", after: "argon2-of-one" },
      viewerHash: { before: "argon2-of-viewer", after: "argon2-of-other" },
    });
    const result = await restoreSnapshot(d, id);

    // Separate flags because the two invalidations are different sizes.
    expect(result.viewerPasswordChanged).toBe(true);
    expect(result.adminPasswordChanged).toBe(false);
  });

  test("losing the viewer password entirely is a change", async () => {
    // The case an operator actually performs: restore a backup from before
    // read-only access was granted, expecting that to revoke it.
    const lost = deps({
      files,
      adminHash: { before: "argon2-of-one", after: "argon2-of-one" },
      viewerHash: { before: "argon2-of-viewer", after: null },
    });
    expect((await restoreSnapshot(lost, id)).viewerPasswordChanged).toBe(true);

    const gained = deps({
      files,
      adminHash: { before: "argon2-of-one", after: "argon2-of-one" },
      viewerHash: { before: null, after: "argon2-of-viewer" },
    });
    expect((await restoreSnapshot(gained, id)).viewerPasswordChanged).toBe(true);
  });

  test("an unchanged viewer password reports no change", async () => {
    // A snapshot of this same installation is the ordinary case; it must not
    // end a read-only session that is still valid.
    const d = deps({
      files,
      adminHash: { before: "argon2-of-one", after: "argon2-of-one" },
      viewerHash: { before: "argon2-of-viewer", after: "argon2-of-viewer" },
    });
    const result = await restoreSnapshot(d, id);
    expect(result.viewerPasswordChanged).toBe(false);
  });

  /**
   * The rebuild is the last thing a restore does, and it is the only one it is
   * allowed to lose.
   *
   * By the time it runs the swap has succeeded and the restored database is
   * live, so a throw here would report a restore that worked as one that
   * failed — and a caller reading `adminPasswordChanged` off the result never
   * reaches it, leaving sessions minted under the old password valid against
   * the new one. The rollup is derived and `doctor` audits it; the invalidation
   * is neither.
   */
  test("a rollup rebuild that fails still returns a result and reports the password change", async () => {
    const d = deps({
      files,
      rebuildFails: true,
      adminHash: { before: "argon2-of-old", after: "argon2-of-new" },
    });

    const result = await restoreSnapshot(d, id);
    expect(result.ok).toBe(true);
    expect(result.adminPasswordChanged).toBe(true);
    expect(result.preRestoreSnapshot.reason).toBe("preRestore");
    // Degraded, not silent: the operator is told the counters are stale and
    // what audits them.
    expect(d.logger.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "usage rollup not rebuilt after the swap; run omni doctor",
      }),
    );
  });

  test("the rebuild runs after the hashes have been compared, not in front of them", async () => {
    // Ordering rather than outcome, because the outcome above only shows the
    // guard. A rebuild that throws in front of the comparison skips it however
    // well guarded it is, so the comparison has to have already happened.
    const d = deps({ files, adminHash: { before: "argon2-of-old", after: "argon2-of-new" } });
    const order: string[] = [];
    const hashes = d.store.config.getAdminPasswordHash;
    d.store.config.getAdminPasswordHash = async () => {
      order.push("getAdminPasswordHash");
      return await hashes();
    };
    const rebuild = d.store.usage.rebuildRollup;
    d.store.usage.rebuildRollup = async () => {
      order.push("rebuildRollup");
      await rebuild();
    };

    await restoreSnapshot(d, id);
    expect(order).toEqual(["getAdminPasswordHash", "getAdminPasswordHash", "rebuildRollup"]);
  });

  /**
   * The likeliest failure of this whole feature, and the one that must not
   * quiesce the gateway.
   *
   * Copying a multi-gigabyte snapshot beside the live database is where ENOSPC
   * lands, and it lands before anything is closed: the live file is byte for
   * byte what it was. Reporting that as a failed swap is what makes a caller
   * refuse client traffic until an operator restarts the process, over a
   * database that was never touched.
   */
  test("a staging copy that fails is an ordinary error, not a failed swap", async () => {
    const d = deps({ files });
    d.fs.copyFile = () => {
      throw new Error("ENOSPC: no space left on device");
    };

    const error = await restoreSnapshot(d, id).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SwapFailedError);
    // Nothing was closed, so there is nothing to be unsure about.
    expect(d.log).not.toContain("close");
    expect(d.files.get(DB)).toBe(4_096);
  });

  test("marks a failure inside the swap, so a caller can keep its latch closed", async () => {
    // The one genuinely bad window. Everything before the swap leaves the live
    // database untouched and is an ordinary error; this is not, and it has to be
    // told apart at the seam rather than by reading a message.
    const d = deps({ files });
    d.fs.rename = () => {
      throw new Error("EXDEV");
    };
    expect(restoreSnapshot(d, id)).rejects.toThrow(SwapFailedError);
  });

  /**
   * The recovery path has to be reachable, and it runs through the same handle.
   *
   * Once `close()` has run there is nothing on the failure path that opens the
   * database again, so the panel an operator would read the failure on, and the
   * second attempt they would make from it, both run against a dead handle. The
   * reopen is best effort and says which it was, because a caller deciding
   * whether to keep refusing client work should not have to guess.
   */
  test("reopens the handle after a failed swap, and says that it did", async () => {
    const d = deps({ files });
    d.fs.rename = () => {
      throw new Error("EXDEV: cross-device link not permitted");
    };

    const error = await restoreSnapshot(d, id).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SwapFailedError);
    expect((error as SwapFailedError).reopened).toBe(true);
    expect(d.log.at(-1)).toBe("reopen");
  });

  test("says so when the handle could not be reopened either", async () => {
    const d = deps({ files });
    d.fs.rename = () => {
      throw new Error("EXDEV: cross-device link not permitted");
    };
    d.store.reopen = async () => {
      throw new Error("unable to open database file");
    };

    const error = await restoreSnapshot(d, id).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SwapFailedError);
    expect((error as SwapFailedError).reopened).toBe(false);
    // The original failure is still the one an operator is shown.
    expect((error as SwapFailedError).cause).toBeInstanceOf(Error);
  });
});

describe("previewRestore", () => {
  const SNAP = `${SNAPSHOTS}/db_2026-08-18T04-12-03-114Z_manual.sqlite`;

  function previewDeps(extra: Parameters<typeof deps>[0] = {}) {
    return deps({
      files: { [DB]: 4_096, [SNAP]: 2_048 },
      inspectBy: {
        [SNAP]: {
          ok: true,
          quickCheck: "ok",
          tables: [],
          counts: { settings: 1, request_logs: 12, api_keys: 3 },
        },
        [DB]: {
          ok: true,
          quickCheck: "ok",
          tables: [],
          counts: { settings: 1, request_logs: 900, credentials: 2 },
        },
      },
      ...extra,
    });
  }

  test("reports both sides, and does not answer one with the other", async () => {
    const d = previewDeps();

    const preview = await previewRestore(d, "db_2026-08-18T04-12-03-114Z_manual.sqlite");

    expect(preview.snapshot).toEqual({ settings: 1, request_logs: 12, api_keys: 3 });
    expect(preview.live).toEqual({ settings: 1, request_logs: 900, credentials: 2 });
  });

  test("swaps nothing, closes nothing, and leaves no working copy behind", async () => {
    const d = previewDeps();
    const before = [...d.files.keys()].sort();

    await previewRestore(d, "db_2026-08-18T04-12-03-114Z_manual.sqlite");

    // The directory listing, not the happy-path return: a dry run that leaves a
    // database-sized file beside the live one is a dry run only in name.
    expect([...d.files.keys()].sort()).toEqual(before);
    expect(d.log).toEqual([`inspect:${SNAP}`, `inspect:${DB}`]);
  });

  test("refuses a file that is a database but not one of ours, as a restore does", async () => {
    const d = previewDeps({
      inspectBy: {
        [SNAP]: {
          ok: false,
          quickCheck: "ok",
          tables: ["albums", "tracks"],
          counts: {},
        },
      },
    });

    await expect(previewRestore(d, "db_2026-08-18T04-12-03-114Z_manual.sqlite")).rejects.toThrow(
      /not one of ours: it has albums, tracks/,
    );
  });

  test("refuses a failed integrity check, as a restore does", async () => {
    const d = previewDeps({
      inspectBy: {
        [SNAP]: { ok: false, quickCheck: "page 4 is never used", tables: [], counts: {} },
      },
    });

    await expect(previewRestore(d, "db_2026-08-18T04-12-03-114Z_manual.sqlite")).rejects.toThrow(
      /failed its integrity check: page 4 is never used/,
    );
  });

  test("a snapshot that is not there is refused before anything is opened", async () => {
    const d = previewDeps();

    await expect(previewRestore(d, "db_2026-08-18T04-12-03-114Z_hourly.sqlite")).rejects.toThrow(
      /no such snapshot/,
    );
    expect(d.log).toEqual([]);
  });

  test("a live database that cannot be read is unknown, never an empty column", async () => {
    // The state a restore exists to repair. Refusing the preview here would
    // withhold the table precisely when it is most worth reading, and reporting
    // `{}` would draw every live cell as absent — which reads as "the restore
    // adds all of this", the opposite of what is known.
    const d = previewDeps({
      inspectBy: {
        [SNAP]: { ok: true, quickCheck: "ok", tables: [], counts: { settings: 1 } },
        [DB]: { ok: false, quickCheck: "unreadable", tables: [], counts: {} },
      },
    });

    const preview = await previewRestore(d, "db_2026-08-18T04-12-03-114Z_manual.sqlite");

    expect(preview.snapshot).toEqual({ settings: 1 });
    expect(preview.live).toBeNull();
  });

  test("holds the single-flight guard, so a restore cannot start under it", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const d = previewDeps({ onInspect: async (path) => (path === SNAP ? held : undefined) });

    const preview = previewRestore(d, "db_2026-08-18T04-12-03-114Z_manual.sqlite");
    // Same two-writers hazard the guard exists for: a preview reading a file
    // mid-swap would report counts from neither side.
    await expect(restoreSnapshot(d, "db_2026-08-18T04-12-03-114Z_manual.sqlite")).rejects.toThrow(
      /already running on this database/,
    );
    release();
    await preview;
  });
});

describe("importSnapshot", () => {
  const staged = "/tmp/omni-import-1.sqlite";

  test("refuses a file over the byte cap without letting it near the database", async () => {
    const d = deps({ files: { [DB]: 4_096, [staged]: MAX_IMPORT_BYTES + 1 } });
    expect(importSnapshot(d, { path: staged })).rejects.toThrow(GatewayError);
    await Bun.sleep(0);
    expect(d.log.some((entry) => entry.startsWith("inspect"))).toBe(false);
    // The staged file was handed over, so it is ours to remove.
    expect(d.files.has(staged)).toBe(false);
  });

  test("takes the same route as a restore: inspect, undo, then swap", async () => {
    const d = deps({ files: { [DB]: 4_096, [staged]: 2_000 } });
    const result = await importSnapshot(d, { path: staged });
    expect(d.log).toEqual([
      `inspect:${staged}`,
      `mkdir:${SNAPSHOTS}`,
      `snapshotTo:${SNAPSHOTS}/${name(AT, "preRestore")}`,
      // Consumed rather than copied: the staged file is a temporary the caller
      // wrote for us and nobody keeps a second copy of it.
      `rename:${staged}->${DB}.incoming`,
      "close",
      `unlink:${DB}-wal`,
      `unlink:${DB}-shm`,
      `rename:${DB}.incoming->${DB}`,
      "reopen",
      "rebuildRollup",
    ]);
    expect(result.ok).toBe(true);
  });

  test("refuses a staged file that is not there", async () => {
    const d = deps();
    expect(importSnapshot(d, { path: staged })).rejects.toThrow(GatewayError);
  });

  test("removes a rejected upload rather than leaving it in the temp directory", async () => {
    const d = deps({
      files: { [DB]: 4_096, [staged]: 2_000 },
      inspect: {
        ok: false,
        quickCheck: "database disk image is malformed",
        tables: [],
        counts: {},
      },
    });
    expect(importSnapshot(d, { path: staged })).rejects.toThrow(GatewayError);
    await Bun.sleep(0);
    expect(d.files.has(staged)).toBe(false);
    expect(d.files.get(DB)).toBe(4_096);
  });
});

describe("vacuum", () => {
  test("reports what it reclaimed and how long it took", async () => {
    const d = deps({ files: { [DB]: 10_000 } });
    let clock = AT;
    d.now = () => (clock += 5);
    d.store.maintenance.vacuum = async () => {
      d.log.push("vacuum");
      d.files.set(DB, 6_000);
    };
    const result = await vacuum(d);
    expect(result.reclaimedBytes).toBe(4_000);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(d.log).toEqual(["vacuum"]);
  });

  test("reports zero rather than a negative when the file grew", async () => {
    // A vacuum can end larger than it started; an operator reading "-2 kB
    // reclaimed" learns nothing they can act on.
    const d = deps({ files: { [DB]: 1_000 } });
    d.store.maintenance.vacuum = async () => {
      d.files.set(DB, 2_000);
    };
    expect((await vacuum(d)).reclaimedBytes).toBe(0);
  });

  test("refuses a second whole-database operation while one is running", async () => {
    const d = deps();
    let release = () => {};
    d.store.maintenance.vacuum = () => new Promise<void>((resolve) => (release = resolve));
    const first = vacuum(d);
    expect(vacuum(d)).rejects.toThrow(GatewayError);
    release();
    await first;

    // And the lock is released again, rather than wedging the installation.
    d.store.maintenance.vacuum = async () => {};
    await vacuum(d);
  });
});

describe("getDatabaseOverview", () => {
  test("answers the operator's question: how big, how much of it is free, what is kept", async () => {
    const d = deps({
      files: {
        [DB]: 409_600,
        [`${DB}-wal`]: 8_192,
        [`${SNAPSHOTS}/${name(AT - DAY)}`]: 1_000,
      },
      settings: { snapshotKeepLatest: 3, snapshotMaxAgeDays: 7 },
    });
    d.fs.dirBytes = () => 12_345;

    const overview = await getDatabaseOverview(d);
    expect(overview.fileBytes).toBe(409_600);
    expect(overview.walBytes).toBe(8_192);
    expect(overview.bodiesBytes).toBe(12_345);
    expect(overview.logicalBytes).toBe(4_096 * 100);
    expect(overview.freePageBytes).toBe(4_096 * 10);
    expect(overview.stats.schemaVersion).toBe(7);
    expect(overview.retention).toEqual({ keepLatest: 3, maxAgeDays: 7 });
    expect(overview.snapshots).toEqual({ count: 1, totalBytes: 1_000, latestAt: AT - DAY });
  });

  test("reads an absent -wal as zero bytes, which is the checkpointed case", async () => {
    expect((await getDatabaseOverview(deps())).walBytes).toBe(0);
  });
});

describe("putRetention", () => {
  test("stores a policy an operator can actually be held to", async () => {
    const d = deps();
    expect(await putRetention(d, { keepLatest: 4, maxAgeDays: 14 })).toEqual({
      keepLatest: 4,
      maxAgeDays: 14,
    });
    expect(d.settings.snapshotKeepLatest).toBe(4);
    expect(d.settings.snapshotMaxAgeDays).toBe(14);
  });

  test.each([
    ["keeping none, which would delete the only undo", { keepLatest: 0, maxAgeDays: 7 }],
    ["a fractional count", { keepLatest: 1.5, maxAgeDays: 7 }],
    ["an age of zero days", { keepLatest: 2, maxAgeDays: 0 }],
    ["a missing field", { keepLatest: 2 }],
    ["an unknown field", { keepLatest: 2, maxAgeDays: 7, cloud: true }],
  ])("refuses %s", async (_, input) => {
    expect(putRetention(deps(), input)).rejects.toThrow(GatewayError);
  });
});
