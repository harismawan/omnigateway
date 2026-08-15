import { expect, test } from "bun:test";
import type { Store } from "@omni/store";
import { memoryStore, quota, seedCredential } from "@omni/testkit";
import { quotaHistory } from "../../src/quota/history.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

/** Writes one retained reading through the real store, as a probe would. */
async function reading(store: Store, credentialId: string, observedAt: number, used: number) {
  await store.credentials.saveQuota([
    quota({
      credentialId,
      windowType: "fiveHour",
      used,
      limit: 100,
      resetsAt: observedAt + HOUR,
      observedAt,
    }),
  ]);
}

async function seeded(): Promise<Store> {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await seedCredential(store, { id: "c2" });
  return store;
}

test("returns the samples inside the requested span", async () => {
  const store = await seeded();
  await reading(store, "c1", NOW - 3 * HOUR, 10);
  await reading(store, "c1", NOW - 2 * HOUR, 20);
  await reading(store, "c1", NOW - HOUR, 30);

  const samples = await quotaHistory(
    { store, now: () => NOW },
    { since: NOW - 2 * HOUR, until: NOW - HOUR },
  );

  expect(samples.map((s) => s.used)).toEqual([20, 30]);
  expect(samples[0]).toMatchObject({
    credentialId: "c1",
    windowType: "fiveHour",
    observedAt: NOW - 2 * HOUR,
    limit: 100,
    windowMs: null,
  });
});

test("filters by credential when one is named", async () => {
  const store = await seeded();
  await reading(store, "c1", NOW - HOUR, 10);
  await reading(store, "c2", NOW - HOUR, 20);

  const all = await quotaHistory({ store, now: () => NOW }, {});
  const one = await quotaHistory({ store, now: () => NOW }, { credentialId: "c2" });

  expect(all).toHaveLength(2);
  expect(one.map((s) => s.credentialId)).toEqual(["c2"]);
});

test("clamps the requested span to the retention window", async () => {
  const store = await seeded();
  await reading(store, "c1", NOW - 40 * DAY, 10);
  await reading(store, "c1", NOW - HOUR, 20);

  const samples = await quotaHistory({ store, now: () => NOW }, { since: 0 });

  // Default retention is thirty days; anything older is already unreadable.
  expect(samples.map((s) => s.used)).toEqual([20]);
});

test("a shortened retention setting shortens the span", async () => {
  const store = await seeded();
  await store.config.putSettings({ logRetentionDays: 1 });
  await reading(store, "c1", NOW - 2 * DAY, 10);
  await reading(store, "c1", NOW - HOUR, 20);

  const samples = await quotaHistory({ store, now: () => NOW }, { since: 0 });

  expect(samples.map((s) => s.used)).toEqual([20]);
});

test("clamps the upper bound to now", async () => {
  const store = await seeded();
  await reading(store, "c1", NOW - HOUR, 10);
  await reading(store, "c1", NOW + HOUR, 20);

  const samples = await quotaHistory({ store, now: () => NOW }, { since: 0, until: NOW + DAY });

  expect(samples.map((s) => s.used)).toEqual([10]);
});

test("accepts the strings a query string produces and ignores unusable ones", async () => {
  const store = await seeded();
  await reading(store, "c1", NOW - 2 * HOUR, 10);
  await reading(store, "c1", NOW - HOUR, 20);

  const strings = await quotaHistory(
    { store, now: () => NOW },
    { since: String(NOW - HOUR), until: String(NOW) },
  );
  expect(strings.map((s) => s.used)).toEqual([20]);

  const nonsense = await quotaHistory({ store, now: () => NOW }, { since: "yesterday" });
  expect(nonsense.map((s) => s.used)).toEqual([10, 20]);
});
