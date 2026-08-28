import { expect, test } from "bun:test";
import type { WindowType } from "@omni/store";
import { memoryStore, quota, seedCredential } from "@omni/testkit";
import { providerHeadroom } from "../../src/quota/headroom.ts";

type QuotaRow = {
  id: string;
  provider: "anthropic" | "openai";
  used: number;
  limit: number | null;
  windowType?: WindowType;
  /** Distinct per row where a test needs to tell the winning account apart. */
  resetsAt?: number;
};

async function withQuota(rows: QuotaRow[]) {
  const store = await memoryStore();
  for (const id of new Set(rows.map((r) => r.id))) {
    const row = rows.find((r) => r.id === id) as QuotaRow;
    await seedCredential(store, { id, provider: row.provider, label: id });
  }
  await store.credentials.saveQuota(
    rows.map((row) =>
      quota({
        credentialId: row.id,
        windowType: row.windowType ?? "fiveHour",
        used: row.used,
        limit: row.limit,
        resetsAt: row.resetsAt ?? 1_800_000_000_000,
        observedAt: 1_799_000_000_000,
      }),
    ),
  );
  return store;
}

/**
 * The redaction this surface exists for.
 *
 * Asserted on the payload, not on what a component renders. A route that
 * fetched the operator's shape and left fields out of the JSX would pass a
 * render assertion while putting the ids on the wire.
 */
test("no credential id or label reaches the result", async () => {
  const store = await withQuota([
    { id: "cred-secret-one", provider: "anthropic", used: 10, limit: 100 },
    { id: "cred-secret-two", provider: "openai", used: 20, limit: 100 },
  ]);

  const rows = await providerHeadroom(store);
  const payload = JSON.stringify(rows);

  expect(payload).not.toContain("cred-secret-one");
  expect(payload).not.toContain("cred-secret-two");
  expect(payload).not.toContain("credentialId");
  expect(
    rows.every((r) => Object.keys(r).sort().join(",") === "provider,resetsAt,usedRatio,windowType"),
  ).toBe(true);
  store.close();
});

/**
 * The minimum, not the maximum and not the mean.
 *
 * The router serves from whichever account can take the request, so one
 * exhausted account among several throttles nobody. Reporting the worst case
 * would have a client chasing a limit that is not affecting them.
 */
test("headroom reports the best account, not the worst or the average", async () => {
  const store = await withQuota([
    { id: "busy", provider: "anthropic", used: 99, limit: 100 },
    { id: "idle", provider: "anthropic", used: 4, limit: 100 },
  ]);

  const [row] = await providerHeadroom(store);
  expect(row?.provider).toBe("anthropic");
  expect(row?.usedRatio).toBeCloseTo(0.04, 6);
  store.close();
});

test("one row per provider and window, not one per account", async () => {
  const store = await withQuota([
    { id: "a1", provider: "anthropic", used: 10, limit: 100 },
    { id: "a2", provider: "anthropic", used: 20, limit: 100 },
    { id: "a3", provider: "anthropic", used: 30, limit: 100 },
    { id: "o1", provider: "openai", used: 40, limit: 100 },
  ]);

  const rows = await providerHeadroom(store);
  // Three anthropic accounts collapse to one row: the count of rows is itself
  // infrastructure detail, so it must not track the number of accounts.
  expect(rows.map((r) => r.provider)).toEqual(["anthropic", "openai"]);
  store.close();
});

test("windows of one provider stay separate rows", async () => {
  const store = await withQuota([
    { id: "a1", provider: "anthropic", used: 10, limit: 100, windowType: "fiveHour" },
    { id: "a1", provider: "anthropic", used: 90, limit: 100, windowType: "weekly" },
  ]);

  // Collapsing to the provider alone would report one number for two different
  // questions, and the 5h figure would hide a week that is nearly spent.
  const rows = await providerHeadroom(store);
  expect(rows.map((r) => [r.windowType, r.usedRatio])).toEqual([
    ["fiveHour", 0.1],
    ["weekly", 0.9],
  ]);
  store.close();
});

test("a provider that reported no ceiling is unknown rather than unlimited", async () => {
  const store = await withQuota([{ id: "a1", provider: "anthropic", used: 50, limit: null }]);

  const [row] = await providerHeadroom(store);
  // Null, not 0. Zero would render as "plenty of room" for an account whose
  // headroom nobody actually knows.
  expect(row?.usedRatio).toBeNull();
  store.close();
});

test("a known figure beats an unknown one whichever order they arrive in", async () => {
  const store = await withQuota([
    { id: "unknown", provider: "anthropic", used: 50, limit: null },
    { id: "known", provider: "anthropic", used: 60, limit: 100 },
  ]);

  const [row] = await providerHeadroom(store);
  expect(row?.usedRatio).toBeCloseTo(0.6, 6);
  store.close();
});

test("a quota row whose credential is gone is dropped", async () => {
  const store = await withQuota([{ id: "a1", provider: "anthropic", used: 10, limit: 100 }]);
  await store.credentials.remove("a1");

  // Not merely filtered on the way out: a dangling id must not survive into the
  // group key either, which is the path that would put it on the wire.
  expect(await providerHeadroom(store)).toEqual([]);
  store.close();
});

test("an install with no quota data reports nothing rather than full headroom", async () => {
  const store = await memoryStore();
  expect(await providerHeadroom(store)).toEqual([]);
  store.close();
});

/**
 * `resetsAt` must belong to the account whose ratio won.
 *
 * Every fixture above gives each row the same `resetsAt`, so the documented
 * property was trivially true for any implementation — returning null, the
 * first row's, or the minimum all passed. Found by mutation: replacing the
 * field with `null` left the suite green.
 *
 * The instant that matters is the one attached to the account actually able to
 * serve, so it has to track the ratio rather than be picked independently.
 */
test("resetsAt comes from the account the ratio came from", async () => {
  const store = await withQuota([
    { id: "busy", provider: "anthropic", used: 99, limit: 100, resetsAt: 1_111_111_111_111 },
    { id: "idle", provider: "anthropic", used: 4, limit: 100, resetsAt: 2_222_222_222_222 },
  ]);

  const [row] = await providerHeadroom(store);
  expect(row?.usedRatio).toBeCloseTo(0.04, 6);
  // The idle account's instant, not the busy one's and not the earliest.
  expect(row?.resetsAt).toBe(2_222_222_222_222);
  store.close();
});

test("a ceiling of zero is unknown rather than a division", async () => {
  // `limit: 0` is a different branch from `limit: null`, and dividing by it
  // would render NaN% on the client surface.
  const store = await withQuota([{ id: "a1", provider: "anthropic", used: 5, limit: 0 }]);
  expect((await providerHeadroom(store))[0]?.usedRatio).toBeNull();
  store.close();
});

test("usage past the ceiling clamps to fully spent", async () => {
  // Reachable: spend is debited in `finishLog` after the request served, so a
  // window can overshoot. A meter reading "150% used" is not a reading.
  const store = await withQuota([{ id: "a1", provider: "anthropic", used: 150, limit: 100 }]);
  expect((await providerHeadroom(store))[0]?.usedRatio).toBe(1);
  store.close();
});

test("a known figure wins whichever order it arrives in — both orders", async () => {
  // The existing test seeds one order only. The reverse takes a different path
  // through the comparison and no fixture reached it.
  const unknownFirst = await withQuota([
    { id: "unknown", provider: "anthropic", used: 50, limit: null },
    { id: "known", provider: "anthropic", used: 60, limit: 100 },
  ]);
  expect((await providerHeadroom(unknownFirst))[0]?.usedRatio).toBeCloseTo(0.6, 6);
  unknownFirst.close();

  const knownFirst = await withQuota([
    { id: "known", provider: "anthropic", used: 60, limit: 100 },
    { id: "unknown", provider: "anthropic", used: 50, limit: null },
  ]);
  expect((await providerHeadroom(knownFirst))[0]?.usedRatio).toBeCloseTo(0.6, 6);
  knownFirst.close();
});
