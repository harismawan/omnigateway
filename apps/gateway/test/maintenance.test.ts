import { expect, test } from "bun:test";
import type { Store } from "@omni/store";
import { memoryStore, requestLog, seedCredential } from "@omni/testkit";
import { pruneLogs } from "../src/maintenance.ts";

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

  expect(await pruneLogs(store, now)).toEqual({ raw: 2, daily: 1, quotaSamples: 0 });

  // Raw logs keep the retention window; the rollup keeps a year and a margin.
  expect((await store.usage.recent(10)).map((l) => l.id)).toEqual(["new"]);
  const days = await store.usage.aggregate({ since: 0, grain: "daily", groupBy: "day" });
  expect(days.map((row) => row.requests)).toEqual([1, 1]);
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
  expect(await pruneLogs(store, CLOCK)).toEqual({ raw: 0, daily: 0, quotaSamples: 1 });

  const kept = await store.credentials.listQuotaSamples({ since: 0, until: CLOCK });
  expect(kept.map((s) => s.used)).toEqual([20]);
});
