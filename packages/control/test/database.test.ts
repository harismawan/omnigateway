import { describe, expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { type DatabaseInspection, DEFAULT_SETTINGS, type Settings } from "@omni/store";
import {
  createSnapshot,
  type DatabaseDeps,
  deleteSnapshot,
  getDatabaseOverview,
  importSnapshot,
  listSnapshots,
  MAX_IMPORT_BYTES,
  putRetention,
  resolveSnapshotForDownload,
  restoreSnapshot,
  SwapFailedError,
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
  } = {},
): Fake {
  const files = new Map<string, number>(Object.entries(input.files ?? { [DB]: 4_096 }));
  const log: string[] = [];
  const settings: Settings = { ...DEFAULT_SETTINGS, ...input.settings };

  return {
    files,
    log,
    settings,
    now: () => input.now ?? AT,
    store: {
      databasePath: DB,
      config: {
        getSettings: async () => settings,
        putSettings: async (patch) => Object.assign(settings, patch),
      },
      maintenance: {
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
          return (
            input.inspect ?? { ok: true, quickCheck: "ok", tables: [], counts: { settings: 1 } }
          );
        },
      },
      close: () => log.push("close"),
      reopen: async () => {
        log.push("reopen");
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

  test("rejects a traversing id before it inspects, snapshots, or closes anything", async () => {
    const d = deps({ files });
    expect(restoreSnapshot(d, "../omnigateway.db")).rejects.toThrow(GatewayError);
    await Bun.sleep(0);
    expect(d.log).toEqual([]);
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
