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
 * The counts behind the fraction stay in `@omni/control` because the chart
 * plots percentages, not because they are secret — `AccountQuota` records why
 * the ceiling is derivable anyway and why that was accepted.
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

/**
 * A parameterless request is bounded, whatever retention allows.
 *
 * This route is reachable by every key holder and is scoped to no credential,
 * so an unbounded default meant one GET read every account's samples across the
 * whole retention window — a synchronous scan that blocks the event loop rather
 * than one request. The operator's own history route keeps no such ceiling: it
 * is admin-gated and scoped to one account.
 */
test("a request with no span reads days, not the whole retention window", async () => {
  const store = await seeded();
  const settings = await store.config.getSettings();
  // Inside retention and well outside what any chart on the client screen asks
  // for: 30 days of retention against a 16-day ceiling.
  expect(settings.logRetentionDays).toBeGreaterThan(17);
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - 25 * DAY, used: 10 });
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - HOUR, used: 20 });

  expect((await historyOf(store)).map((s) => s.observedAt)).toEqual([NOW - HOUR]);
  store.close();
});

test("an explicit span cannot reach past that ceiling either", async () => {
  const store = await seeded();
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - 25 * DAY, used: 10 });
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - HOUR, used: 20 });

  // Asking for everything is not a way around it.
  const result = await accountQuotaHistory({ store, now: () => NOW }, { since: 0 });
  expect(result.samples.map((s) => s.observedAt)).toEqual([NOW - HOUR]);
  store.close();
});

/**
 * The cap is asked of the store, and a read that hits it says so.
 *
 * Two tests rather than one seeded fixture: proving truncation end-to-end means
 * writing fifty thousand rows, which is slow enough that nobody would run it.
 * Watching the query instead pins the wiring — deleting `limit: MAX_SAMPLES`
 * from the call left every other test in this file green — and a fabricated
 * full page pins what the flag means.
 */
test("the store is asked for a bounded page", async () => {
  const store = await seeded();
  await reading(store, { credentialId: "cred-alpha", observedAt: NOW - HOUR, used: 10 });

  const seen: Array<{ limit?: number | undefined }> = [];
  const watched = {
    ...store,
    credentials: {
      ...store.credentials,
      listQuotaSamples: async (q: Parameters<typeof store.credentials.listQuotaSamples>[0]) => {
        seen.push(q);
        return store.credentials.listQuotaSamples(q);
      },
    },
  } as Store;

  const result = await accountQuotaHistory({ store: watched, now: () => NOW }, {});
  expect(seen).toHaveLength(1);
  expect(typeof seen[0]?.limit).toBe("number");
  // A page that came back short of the cap is the whole history, not a slice.
  expect(result.truncated).toBe(false);
  store.close();
});

test("a full page is reported as truncated rather than drawn as a gap", async () => {
  const store = await seeded();
  const full = {
    ...store,
    credentials: {
      ...store.credentials,
      listQuotaSamples: async (q: Parameters<typeof store.credentials.listQuotaSamples>[0]) =>
        // Exactly the cap: what the store returns when there was more to read.
        Array.from({ length: q.limit ?? 0 }, (_unused, index) => ({
          credentialId: "cred-alpha",
          windowType: "fiveHour" as const,
          observedAt: NOW - index * 60_000,
          used: 10,
          limit: 100,
          resetsAt: RESETS_AT,
          windowMs: null,
        })),
    },
  } as Store;

  // The panel states its own x axis from the span it asked for, so a shortened
  // series drawn against it looks exactly like a gateway that was not running.
  expect((await accountQuotaHistory({ store: full, now: () => NOW }, {})).truncated).toBe(true);
  store.close();
});
