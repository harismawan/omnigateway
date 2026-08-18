import { describe, expect, test } from "bun:test";
import type { DatabaseDeps } from "@omni/control";
import type { Store } from "@omni/store";
import { memoryStore, requestLog, seedCredential } from "@omni/testkit";
import { pruneFiles, pruneLogs } from "../src/maintenance.ts";

const NOW = 30 * 24 * 60 * 60 * 1000;

async function log(store: Store, id: string, at: number) {
  await store.usage.append(requestLog({ id, at }));
}

test("deletes logs older than the retention window", async () => {
  const store = await memoryStore();
  await log(store, "old", NOW - 31 * 24 * 60 * 60 * 1000);
  await log(store, "new", NOW - 1000);

  await pruneLogs(store, NOW);

  const remaining = await store.usage.recent(10);
  expect(remaining.map((l) => l.id)).toEqual(["new"]);
});

test("honours a changed retention setting", async () => {
  const store = await memoryStore();
  await store.config.putSettings({ logRetentionDays: 1 });
  await log(store, "old", NOW - 2 * 24 * 60 * 60 * 1000);
  await log(store, "new", NOW - 1000);

  await pruneLogs(store, NOW);
  expect((await store.usage.recent(10)).map((l) => l.id)).toEqual(["new"]);
});

test("pruning an empty log table is a no-op", async () => {
  const store = await memoryStore();
  await pruneLogs(store, NOW);
  expect(await store.usage.recent(10)).toHaveLength(0);
});

test("the rollup survives log pruning and is swept on its own horizon", async () => {
  const store = await memoryStore();
  const day = 24 * 60 * 60 * 1000;
  const now = 500 * day;
  await log(store, "ancient", now - 401 * day);
  await log(store, "old", now - 31 * day);
  await log(store, "new", now - 1000);

  expect(await pruneLogs(store, now)).toEqual({
    raw: 2,
    daily: 1,
    quotaSamples: 0,
    bodies: 0,
    bodiesOverCap: 0,
    bodyOrphans: 0,
  });

  // Raw logs keep the retention window; the rollup keeps a year and a margin.
  expect((await store.usage.recent(10)).map((l) => l.id)).toEqual(["new"]);
  const days = await store.usage.aggregate({ since: 0, grain: "daily", groupBy: "day" });
  expect(days.map((row) => row.requests)).toEqual([1, 1]);
});

/**
 * The other half of the sweep: files, rather than rows.
 *
 * Snapshot retention ran only on the way out of a create, so an installation
 * that stopped taking snapshots never expired one and a lowered `keepLatest`
 * did nothing until the next create — while the panel says both apply on the
 * hourly sweep. Staging files had nothing sweeping them at all.
 */
describe("pruneFiles", () => {
  const DB = "/srv/omni/omnigateway.db";
  const SNAPSHOTS = "/srv/omni/snapshots";
  const AT = Date.parse("2026-08-18T04:12:03.114Z");
  const DAY = 24 * 60 * 60 * 1000;

  const snapshotName = (at: number, reason = "manual") =>
    `db_${new Date(at).toISOString().replaceAll(":", "-").replaceAll(".", "-")}_${reason}.sqlite`;

  /** A filesystem that is a map, so the sweep is exercised and nothing is. */
  async function deps(files: Record<string, number>, now: number): Promise<DatabaseDeps> {
    const map = new Map(Object.entries(files));
    const store = await memoryStore();
    return {
      store: { ...store, databasePath: DB },
      now: () => now,
      fs: {
        readdir: (dir) =>
          [...map.keys()]
            .filter((path) => path.startsWith(`${dir}/`))
            .map((path) => path.slice(dir.length + 1)),
        stat: (path) => {
          const size = map.get(path);
          return size === undefined ? null : { size, mtimeMs: AT };
        },
        unlink: (path) => {
          map.delete(path);
        },
        rename: () => {
          throw new Error("the sweep does not move files");
        },
        copyFile: () => {
          throw new Error("the sweep does not copy files");
        },
        mkdir: () => {
          throw new Error("the sweep does not create directories");
        },
        realpath: (path) => (map.has(path) ? path : null),
        freeBytes: () => null,
        dirBytes: () => 0,
      },
    };
  }

  test("expires snapshots the saved policy no longer covers, with no create to trigger it", async () => {
    const d = await deps(
      {
        [DB]: 4_096,
        [`${SNAPSHOTS}/${snapshotName(AT - 40 * DAY)}`]: 100,
        [`${SNAPSHOTS}/${snapshotName(AT - 39 * DAY)}`]: 100,
        [`${SNAPSHOTS}/${snapshotName(AT - 1 * DAY)}`]: 100,
      },
      AT,
    );
    await d.store.config.putSettings({ snapshotKeepLatest: 5, snapshotMaxAgeDays: 30 });

    expect(await pruneFiles(d)).toEqual({ snapshots: 2, staging: 0 });
  });

  test("removes the staging files a refused import and a failed swap leave behind", async () => {
    const d = await deps(
      {
        [DB]: 4_096,
        "/srv/omni/omni-import-6f1b.sqlite.part": 2_000,
        [`${DB}.incoming`]: 2_000,
      },
      AT + 5 * 60 * 60 * 1000,
    );

    expect(await pruneFiles(d)).toEqual({ snapshots: 0, staging: 2 });
  });
});

/** A clock far enough from the epoch that retention may reach backwards. */
const CLOCK = 1_700_000_000_000;

async function reading(store: Store, observedAt: number, used: number) {
  await store.credentials.saveQuota([
    {
      credentialId: "c1",
      windowType: "fiveHour",
      startsAt: observedAt,
      used,
      limit: 100,
      resetsAt: observedAt + 3_600_000,
      observedAt,
      windowMs: null,
    },
  ]);
}

test("retained quota samples are swept on the raw log horizon", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  const day = 24 * 60 * 60 * 1000;
  await reading(store, CLOCK - 31 * day, 10);
  await reading(store, CLOCK - 1000, 20);

  // The raw horizon, not the rollup's far longer one: a sample describes a
  // moment, and there is no rolled-up form of it to keep.
  expect(await pruneLogs(store, CLOCK)).toEqual({
    raw: 0,
    daily: 0,
    quotaSamples: 1,
    bodies: 0,
    bodiesOverCap: 0,
    bodyOrphans: 0,
  });

  const kept = await store.credentials.listQuotaSamples({ since: 0, until: CLOCK });
  expect(kept.map((s) => s.used)).toEqual([20]);
});
