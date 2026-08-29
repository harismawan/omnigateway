import { expect, test } from "bun:test";
import type { Store, WindowType } from "@omni/store";
import { memoryStore, quota, seedCredential } from "@omni/testkit";
import { accountQuotaHistory } from "../../src/quota/clientHistory.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;
/** Fixed so a run is one window: `resetsAt` moving is what splits runs apart. */
const RESETS_AT = NOW + HOUR;

type Reading = {
  credentialId: string;
  observedAt: number;
  used: number;
  limit?: number | null;
  windowType?: WindowType;
  resetsAt?: number | null;
};

/** Writes one retained reading through the real store, as a probe would. */
async function reading(store: Store, row: Reading) {
  await store.credentials.saveQuota([
    quota({
      credentialId: row.credentialId,
      windowType: row.windowType ?? "fiveHour",
      used: row.used,
      limit: row.limit === undefined ? 100 : row.limit,
      resetsAt: row.resetsAt === undefined ? RESETS_AT : row.resetsAt,
      observedAt: row.observedAt,
    }),
  ]);
}

async function seeded(): Promise<Store> {
  const store = await memoryStore();
  await seedCredential(store, { id: "cred-alpha", provider: "anthropic", label: "alpha" });
  await seedCredential(store, { id: "cred-beta", provider: "anthropic", label: "beta" });
  await seedCredential(store, { id: "cred-openai", provider: "openai", label: "codex" });
  return store;
}

async function historyOf(store: Store, now = NOW) {
  return (await accountQuotaHistory({ store, now: () => now }, {})).samples;
}

/**
 * The pair the chart joins on: which account, and what fraction it was at.
 *
 * The counts behind the fraction stay in `@omni/control` — an account a client
 * can watch filling up is not an account whose size it has been told.
 */
test("a sample names its account and carries no provider units", async () => {
  const store = await seeded();
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - HOUR, used: 25 });

  const [sample] = await historyOf(store);
  expect(sample?.label).toBe("alpha");
  expect(sample?.usedRatio).toBeCloseTo(0.25, 6);
  expect(
    Object.keys(sample ?? {})
      .sort()
      .join(","),
  ).toBe("credentialId,label,observedAt,provider,resetsAt,usedRatio,windowMs,windowType");
  store.close();
});

/**
 * One series per account, so a client can see which of two is filling up.
 *
 * The folded version of this drew one line per provider and could not answer
 * that question at all.
 */
test("each account keeps its own series", async () => {
  const store = await seeded();
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - 2 * HOUR, used: 90 });
  await reading(store, { credentialId: "cred-beta", observedAt: NOW - HOUR, used: 10 });

  const samples = await historyOf(store);
  expect(samples.map((s) => [s.label, s.usedRatio])).toEqual([
    ["alpha", 0.9],
    ["beta", 0.1],
  ]);
  store.close();
});

test("readings of one account arrive oldest first", async () => {
  const store = await seeded();
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - 3 * HOUR, used: 10 });
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - 2 * HOUR, used: 20 });
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - HOUR, used: 30 });

  expect((await historyOf(store)).map((s) => s.usedRatio)).toEqual([0.1, 0.2, 0.3]);
  store.close();
});

/**
 * A percentage of an unstated ceiling is not a number, and drawing it at zero
 * would claim an idle account. The console applies the same rule to the
 * operator's readings in `quotaSegments`.
 */
test("readings against no stated ceiling produce no points", async () => {
  const store = await seeded();
  await reading(store, {
    credentialId: "cred-alpha",
    observedAt: NOW - HOUR,
    used: 50,
    limit: null,
  });
  await reading(store, {
    credentialId: "cred-beta",
    observedAt: NOW - 30 * 60_000,
    used: 5,
    limit: 0,
  });

  expect(await historyOf(store)).toEqual([]);
  store.close();
});

test("providers and window types are separate series", async () => {
  const store = await seeded();
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - 2 * HOUR, used: 10 });
  await reading(store, {
    credentialId: "cred-alpha",
    observedAt: NOW - 2 * HOUR,
    used: 90,
    windowType: "weekly",
  });
  await reading(store, { credentialId: "cred-openai", observedAt: NOW - HOUR, used: 40 });

  const samples = await historyOf(store);
  expect(samples.map((s) => [s.provider, s.label, s.windowType, s.usedRatio])).toEqual([
    ["anthropic", "alpha", "fiveHour", 0.1],
    ["anthropic", "alpha", "weekly", 0.9],
    ["openai", "codex", "fiveHour", 0.4],
  ]);
  store.close();
});

test("a sample whose credential is gone is dropped", async () => {
  const store = await seeded();
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - HOUR, used: 10 });
  await store.credentials.remove("cred-alpha");

  // There is no account left to name it after, exactly as the live reading of
  // that account is dropped.
  expect(await historyOf(store)).toEqual([]);
  store.close();
});

/**
 * The span rule is `@omni/control`'s, shared with the operator's history route
 * through `retainedSpan`: a request for everything cannot read further back than
 * the rows actually go.
 */
test("the span is clamped to what pruning leaves readable", async () => {
  const store = await seeded();
  const settings = await store.config.getSettings();
  const outside = NOW - (settings.logRetentionDays + 1) * DAY;
  await reading(store, { credentialId: "cred-alpha", observedAt: outside, used: 10 });
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - HOUR, used: 20 });

  const result = await accountQuotaHistory({ store, now: () => NOW }, { since: outside - DAY });
  expect(result.samples.map((s) => s.observedAt)).toEqual([NOW - HOUR]);
  store.close();
});

test("an explicit span narrows the readings returned", async () => {
  const store = await seeded();
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - 4 * HOUR, used: 10 });
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - 2 * HOUR, used: 20 });
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - HOUR, used: 30 });

  const result = await accountQuotaHistory(
    { store, now: () => NOW },
    { since: NOW - 3 * HOUR, until: NOW - 90 * 60_000 },
  );
  expect(result.samples.map((s) => s.usedRatio)).toEqual([0.2]);
  store.close();
});

test("an install with no readings reports nothing rather than an empty window", async () => {
  const store = await memoryStore();
  expect(await historyOf(store)).toEqual([]);
  store.close();
});
