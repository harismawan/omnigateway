import { expect, test } from "bun:test";
import type { QuotaSample, Store } from "@omni/store";
import { memoryStore, quota, requestLog, seedCredential } from "@omni/testkit";
import { quotaHistory } from "../../src/quota/history.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

/** The samples alone, for the assertions that predate the gateway rate. */
async function samplesOf(
  store: Store,
  input: Parameters<typeof quotaHistory>[1] = {},
  now: number = NOW,
): Promise<QuotaSample[]> {
  return (await quotaHistory({ store, now: () => now }, input)).samples;
}

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

  const samples = await samplesOf(store, { since: NOW - 2 * HOUR, until: NOW - HOUR });

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

  const all = await samplesOf(store);
  const one = await samplesOf(store, { credentialId: "c2" });

  expect(all).toHaveLength(2);
  expect(one.map((s) => s.credentialId)).toEqual(["c2"]);
});

test("clamps the requested span to the retention window", async () => {
  const store = await seeded();
  await reading(store, "c1", NOW - 40 * DAY, 10);
  await reading(store, "c1", NOW - HOUR, 20);

  const samples = await samplesOf(store, { since: 0 });

  // Default retention is thirty days; anything older is already unreadable.
  expect(samples.map((s) => s.used)).toEqual([20]);
});

test("a shortened retention setting shortens the span", async () => {
  const store = await seeded();
  await store.config.putSettings({ logRetentionDays: 1 });
  await reading(store, "c1", NOW - 2 * DAY, 10);
  await reading(store, "c1", NOW - HOUR, 20);

  const samples = await samplesOf(store, { since: 0 });

  expect(samples.map((s) => s.used)).toEqual([20]);
});

test("clamps the upper bound to now", async () => {
  const store = await seeded();
  await reading(store, "c1", NOW - HOUR, 10);
  await reading(store, "c1", NOW + HOUR, 20);

  const samples = await samplesOf(store, { since: 0, until: NOW + DAY });

  expect(samples.map((s) => s.used)).toEqual([10]);
});

test("accepts the strings a query string produces and ignores unusable ones", async () => {
  const store = await seeded();
  await reading(store, "c1", NOW - 2 * HOUR, 10);
  await reading(store, "c1", NOW - HOUR, 20);

  const strings = await samplesOf(store, { since: String(NOW - HOUR), until: String(NOW) });
  expect(strings.map((s) => s.used)).toEqual([20]);

  const nonsense = await samplesOf(store, { since: "yesterday" });
  expect(nonsense.map((s) => s.used)).toEqual([10, 20]);
});

test("an empty query param reads as absent rather than as the epoch", async () => {
  const store = await seeded();
  await reading(store, "c1", NOW - 2 * HOUR, 10);
  await reading(store, "c1", NOW - HOUR, 20);

  // `?since=&until=` is what a form or a hand-built query string produces, and
  // `Number("")` is 0 — so an unguarded upper bound clamps to the epoch and
  // returns nothing at all.
  const blank = await samplesOf(store, { since: "", until: "" });

  expect(blank.map((s) => s.used)).toEqual([10, 20]);
});

test("whitespace is treated the same way as an empty param", async () => {
  const store = await seeded();
  await reading(store, "c1", NOW - HOUR, 10);

  const blank = await samplesOf(store, { since: "  ", until: "\t" });

  expect(blank.map((s) => s.used)).toEqual([10]);
});

/** Writes a completed request against a credential, as dispatch would. */
async function log(
  store: Store,
  id: string,
  at: number,
  overrides: Partial<Parameters<typeof requestLog>[0]> = {},
) {
  await store.usage.append(requestLog({ id, at, credentialId: "c1", ...overrides }));
}

test("the gateway rate covers the same span the provider rate is averaged over", async () => {
  const store = await seeded();
  // A five-hour window read two hours in, exactly as `burnFor` sees it.
  const start = NOW - 2 * HOUR;
  await store.credentials.saveQuota([
    quota({
      credentialId: "c1",
      windowType: "fiveHour",
      used: 100,
      limit: 1_000,
      resetsAt: NOW + 3 * HOUR,
      observedAt: NOW,
    }),
  ]);

  await log(store, "in", start + HOUR, {
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 400,
    cacheWriteTokens: 300,
  });
  await log(store, "other", start + HOUR, { credentialId: "c2", inputTokens: 9_000 });
  await log(store, "before", start - 1, { inputTokens: 9_000 });
  // Anchored to the reading, not to the clock: traffic after the snapshot is
  // outside the span the provider counted, so counting it would compare two
  // rates over different hours.
  await log(store, "after", NOW + 1, { inputTokens: 9_000 });

  const { gatewayRates } = await quotaHistory(
    { store, now: () => NOW + 60_000 },
    { credentialId: "c1" },
  );

  // 1000 tokens over the same two hours.
  expect(gatewayRates).toEqual([
    { credentialId: "c1", windowType: "fiveHour", gatewayRatePerHour: 500 },
  ]);
});

test("a credential with no gateway traffic in the span reports a zero rate", async () => {
  const store = await seeded();
  await store.credentials.saveQuota([
    quota({
      credentialId: "c1",
      windowType: "fiveHour",
      used: 100,
      limit: 1_000,
      resetsAt: NOW + 3 * HOUR,
      observedAt: NOW,
    }),
  ]);

  const { gatewayRates } = await quotaHistory({ store, now: () => NOW }, { credentialId: "c1" });

  expect(gatewayRates[0]?.gatewayRatePerHour).toBe(0);
});

test("a window with no stated reset has no span and so no gateway rate", async () => {
  const store = await seeded();
  await store.credentials.saveQuota([
    quota({
      credentialId: "c1",
      windowType: "fiveHour",
      used: 100,
      limit: 1_000,
      resetsAt: null,
      observedAt: NOW,
    }),
  ]);
  await log(store, "in", NOW - HOUR, { inputTokens: 1_000 });

  const { gatewayRates } = await quotaHistory({ store, now: () => NOW }, { credentialId: "c1" });

  expect(gatewayRates).toEqual([
    { credentialId: "c1", windowType: "fiveHour", gatewayRatePerHour: null },
  ]);
});

test("naming a credential scopes the gateway rates to its own windows", async () => {
  const store = await seeded();
  const window = (credentialId: string, windowType: "fiveHour" | "weekly") =>
    quota({
      credentialId,
      windowType,
      used: 100,
      limit: 1_000,
      resetsAt: NOW + 3 * HOUR,
      observedAt: NOW,
    });
  await store.credentials.saveQuota([
    window("c1", "fiveHour"),
    window("c1", "weekly"),
    window("c2", "fiveHour"),
  ]);

  const scoped = await quotaHistory({ store, now: () => NOW }, { credentialId: "c1" });
  const all = await quotaHistory({ store, now: () => NOW }, {});

  expect(scoped.gatewayRates.map((r) => `${r.credentialId}|${r.windowType}`)).toEqual([
    "c1|fiveHour",
    "c1|weekly",
  ]);
  expect(all.gatewayRates).toHaveLength(3);
});

test("in-flight requests are left out of the gateway rate", async () => {
  const store = await seeded();
  await store.credentials.saveQuota([
    quota({
      credentialId: "c1",
      windowType: "fiveHour",
      used: 100,
      limit: 1_000,
      resetsAt: NOW + 3 * HOUR,
      observedAt: NOW,
    }),
  ]);
  await store.usage.begin(
    requestLog({ id: "pending", at: NOW - HOUR, credentialId: "c1", inputTokens: 9_000 }),
  );

  const { gatewayRates } = await quotaHistory({ store, now: () => NOW }, { credentialId: "c1" });

  expect(gatewayRates[0]?.gatewayRatePerHour).toBe(0);
});
