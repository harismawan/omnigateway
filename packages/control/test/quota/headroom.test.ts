import { expect, test } from "bun:test";
import type { WindowType } from "@omni/store";
import { memoryStore, quota, seedCredential } from "@omni/testkit";
import { accountQuota } from "../../src/quota/headroom.ts";

/** The instant every fixture below is read at: the same one it was observed at. */
const NOW = 1_799_000_000_000;
const HOUR_MS = 3_600_000;

type QuotaRow = {
  id: string;
  provider: "anthropic" | "openai";
  label?: string;
  used: number;
  limit: number | null;
  windowType?: WindowType;
  /** Distinct per row where a test needs to tell one account's window apart. */
  resetsAt?: number;
  observedAt?: number;
};

async function withQuota(rows: QuotaRow[]) {
  const store = await memoryStore();
  for (const id of new Set(rows.map((r) => r.id))) {
    const row = rows.find((r) => r.id === id) as QuotaRow;
    await seedCredential(store, { id, provider: row.provider, label: row.label ?? id });
  }
  await store.credentials.saveQuota(
    rows.map((row) =>
      quota({
        credentialId: row.id,
        windowType: row.windowType ?? "fiveHour",
        used: row.used,
        limit: row.limit,
        resetsAt: row.resetsAt ?? 1_800_000_000_000,
        observedAt: row.observedAt ?? NOW,
      }),
    ),
  );
  return store;
}

/**
 * The disclosure this surface makes, and the one it does not.
 *
 * Account names reach a client by the operator's decision: a screen that
 * collapsed a provider's accounts could not say which one was filling up. The
 * size of an account is a different question and is still withheld — every
 * figure is a fraction of the window it belongs to.
 */
test("an account is named, and its ceiling is not", async () => {
  const store = await withQuota([
    { id: "cred-1", provider: "anthropic", label: "claude-main", used: 250, limit: 1_000 },
  ]);

  const [row] = await accountQuota({ store, now: () => NOW });
  expect(row?.label).toBe("claude-main");
  expect(row?.usedRatio).toBeCloseTo(0.25, 6);

  // The provider's own counters must not be reconstructible from the payload.
  const payload = JSON.stringify(row);
  expect(payload).not.toContain("250");
  expect(payload).not.toContain("1000");
  expect(
    Object.keys(row ?? {})
      .sort()
      .join(","),
  ).toBe(
    "credentialId,exhaustsAt,label,observedAt,provider,ratePerHourRatio,resetsAt,rolledOver,stale,survives,usedRatio,windowMs,windowType",
  );
  store.close();
});

/**
 * Every account, not the best one.
 *
 * The collapsed version of this reported one row per provider and answered "am
 * I about to be throttled" only. A client watching two accounts wants to know
 * which of them is the one filling up.
 */
test("every account of a provider is reported, not one row for the pool", async () => {
  const store = await withQuota([
    { id: "busy", provider: "anthropic", label: "claude-busy", used: 99, limit: 100 },
    { id: "idle", provider: "anthropic", label: "claude-idle", used: 4, limit: 100 },
  ]);

  const rows = await accountQuota({ store, now: () => NOW });
  expect(rows.map((r) => [r.label, r.usedRatio])).toEqual([
    ["claude-busy", 0.99],
    ["claude-idle", 0.04],
  ]);
  store.close();
});

test("rows sort by provider, then account, then window", async () => {
  const store = await withQuota([
    { id: "o1", provider: "openai", label: "codex", used: 40, limit: 100 },
    { id: "a2", provider: "anthropic", label: "beta", used: 20, limit: 100 },
    { id: "a1", provider: "anthropic", label: "alpha", used: 10, limit: 100 },
    {
      id: "a1",
      provider: "anthropic",
      label: "alpha",
      used: 90,
      limit: 100,
      windowType: "weekly",
    },
  ]);

  const rows = await accountQuota({ store, now: () => NOW });
  expect(rows.map((r) => `${r.provider}/${r.label}/${r.windowType}`)).toEqual([
    "anthropic/alpha/fiveHour",
    "anthropic/alpha/weekly",
    "anthropic/beta/fiveHour",
    "openai/codex/fiveHour",
  ]);
  store.close();
});

test("windows of one account stay separate rows", async () => {
  const store = await withQuota([
    { id: "a1", provider: "anthropic", used: 10, limit: 100, windowType: "fiveHour" },
    { id: "a1", provider: "anthropic", used: 90, limit: 100, windowType: "weekly" },
  ]);

  // Collapsing them would report one number for two different questions, and
  // the 5h figure would hide a week that is nearly spent.
  const rows = await accountQuota({ store, now: () => NOW });
  expect(rows.map((r) => [r.windowType, r.usedRatio])).toEqual([
    ["fiveHour", 0.1],
    ["weekly", 0.9],
  ]);
  store.close();
});

test("an account that reported no ceiling is unknown rather than unlimited", async () => {
  const store = await withQuota([{ id: "a1", provider: "anthropic", used: 50, limit: null }]);

  const [row] = await accountQuota({ store, now: () => NOW });
  // Null, not 0. Zero would render as "plenty of room" for an account whose
  // headroom nobody actually knows.
  expect(row?.usedRatio).toBeNull();
  store.close();
});

test("a quota row whose credential is gone is dropped", async () => {
  const store = await withQuota([{ id: "a1", provider: "anthropic", used: 10, limit: 100 }]);
  await store.credentials.remove("a1");

  // There is no account left to name, and a row keyed on a dangling id would
  // put that id on the wire without a label to go with it.
  expect(await accountQuota({ store, now: () => NOW })).toEqual([]);
  store.close();
});

test("an install with no quota data reports nothing rather than full headroom", async () => {
  const store = await memoryStore();
  expect(await accountQuota({ store, now: () => NOW })).toEqual([]);
  store.close();
});

test("a ceiling of zero is unknown rather than a division", async () => {
  // `limit: 0` is a different branch from `limit: null`, and dividing by it
  // would render NaN% on the client surface.
  const store = await withQuota([{ id: "a1", provider: "anthropic", used: 5, limit: 0 }]);
  expect((await accountQuota({ store, now: () => NOW }))[0]?.usedRatio).toBeNull();
  store.close();
});

test("usage past the ceiling clamps to fully spent", async () => {
  // Reachable: spend is debited in `finishLog` after the request served, so a
  // window can overshoot. A meter reading "150% used" is not a reading.
  const store = await withQuota([{ id: "a1", provider: "anthropic", used: 150, limit: 100 }]);
  expect((await accountQuota({ store, now: () => NOW }))[0]?.usedRatio).toBe(1);
  store.close();
});

/**
 * The burn rate is scaled exactly as `usedRatio` is, and for the same reason.
 *
 * Provider units are the size of an account. A fraction of the ceiling per hour
 * answers the question a client asks — will this run out before it resets — and
 * answers nothing else.
 */
test("the burn rate reaches the client as a fraction of the ceiling, not in provider units", async () => {
  const store = await withQuota([
    {
      id: "a1",
      provider: "anthropic",
      used: 400,
      limit: 1000,
      // A five-hour window resetting in an hour began four hours ago, so 400
      // units of a 1000 ceiling is 100 units/h and a tenth of the ceiling.
      resetsAt: NOW + HOUR_MS,
      observedAt: NOW,
    },
  ]);

  const [row] = await accountQuota({ store, now: () => NOW });
  expect(row?.ratePerHourRatio).toBeCloseTo(0.1, 6);
  // The provider's own figure must not be reconstructible from the payload.
  expect(JSON.stringify(row)).not.toContain("100");
  store.close();
});

test("a rate against an unstated ceiling is unknown rather than a division", async () => {
  const store = await withQuota([
    { id: "a1", provider: "anthropic", used: 400, limit: null, resetsAt: NOW + HOUR_MS },
  ]);
  expect((await accountQuota({ store, now: () => NOW }))[0]?.ratePerHourRatio).toBeNull();
  store.close();
});

/**
 * Staleness is decided here, not on the client.
 *
 * `burnFor` owns both tests, and one of them — `quotaRolledOver` — has exactly
 * one copy by rule. A client re-deriving the other would also need
 * `quotaPollIntervalMs`, which is a setting on a route it cannot read.
 */
test("a reading too old to believe is reported stale, with no rate", async () => {
  const store = await withQuota([
    {
      id: "a1",
      provider: "anthropic",
      used: 400,
      limit: 1000,
      resetsAt: NOW + HOUR_MS,
      // Well past `quotaStaleAfterMs` of the default 5-minute poll interval.
      observedAt: NOW - 6 * HOUR_MS,
    },
  ]);

  const [row] = await accountQuota({ store, now: () => NOW });
  expect(row?.stale).toBe(true);
  expect(row?.rolledOver).toBe(false);
  expect(row?.ratePerHourRatio).toBeNull();
  // The measurement survives the verdict: what was read is still what was read.
  expect(row?.usedRatio).toBeCloseTo(0.4, 6);
  store.close();
});

/**
 * A rolled-over reading is reported apart from a stale one.
 *
 * Folding the two would blank a client's chart for up to a poll interval after
 * every rollover, throwing away readings that were measured and stay measured.
 */
test("a window whose own reset has passed is rolled over, not merely stale", async () => {
  const store = await withQuota([
    {
      id: "a1",
      provider: "anthropic",
      used: 400,
      limit: 1000,
      // Minutes old, and counting a window that ended an hour ago.
      resetsAt: NOW - HOUR_MS,
      observedAt: NOW - 60_000,
    },
  ]);

  const [row] = await accountQuota({ store, now: () => NOW });
  expect(row?.rolledOver).toBe(true);
  // Minutes old, so every staleness check calls it current — which is the trap
  // the two flags exist to keep apart.
  expect(row?.stale).toBe(false);
  expect(row?.ratePerHourRatio).toBeNull();
  expect(row?.survives).toBeNull();
  store.close();
});

/**
 * `resetsAt`, `observedAt` and `windowMs` belong to the row they came from.
 *
 * They are what place a reading on the chart's timeline, and taking any of them
 * from another account would draw one account's ratio at another's instant.
 */
test("each row carries its own account's instants", async () => {
  const store = await withQuota([
    {
      id: "busy",
      provider: "anthropic",
      label: "busy",
      used: 99,
      limit: 100,
      resetsAt: NOW + HOUR_MS,
      observedAt: NOW - 30 * 60_000,
    },
    {
      id: "idle",
      provider: "anthropic",
      label: "idle",
      used: 4,
      limit: 100,
      resetsAt: NOW + 2 * HOUR_MS,
      observedAt: NOW - 60_000,
    },
  ]);

  const rows = await accountQuota({ store, now: () => NOW });
  const busy = rows.find((r) => r.label === "busy");
  const idle = rows.find((r) => r.label === "idle");
  expect(busy?.resetsAt).toBe(NOW + HOUR_MS);
  expect(busy?.observedAt).toBe(NOW - 30 * 60_000);
  expect(idle?.resetsAt).toBe(NOW + 2 * HOUR_MS);
  expect(idle?.observedAt).toBe(NOW - 60_000);
  store.close();
});
