import { expect, test } from "bun:test";
import { memoryStore, requestLog, seedApiKey } from "@omni/testkit";
import { readOwnKey } from "../src/keys.ts";
import { type Principal, scopeOf } from "../src/principal.ts";
import { queryUsage, recentLogs } from "../src/usage.ts";

const MACHINE: Principal = { kind: "machine", tokenId: "t1", pluginId: "p1" };

const NOW = 1_800_000_000_000;
const deps = (store: Awaited<ReturnType<typeof memoryStore>>) => ({ store, now: () => NOW });

/** Two keys with traffic, plus one anonymous row nobody owns. */
async function seeded() {
  const store = await memoryStore();
  const mine = await seedApiKey(store, { label: "mine" });
  const theirs = await seedApiKey(store, { label: "theirs" });

  await store.usage.append(
    requestLog({ id: "m1", at: NOW - 3_000, apiKeyId: mine.key.id, costUsd: 1 }),
  );
  await store.usage.append(
    requestLog({ id: "t1", at: NOW - 2_000, apiKeyId: theirs.key.id, costUsd: 100 }),
  );
  await store.usage.append(
    requestLog({ id: "m2", at: NOW - 1_000, apiKeyId: mine.key.id, costUsd: 2 }),
  );
  await store.usage.append(requestLog({ id: "anon", at: NOW - 500, apiKeyId: null, costUsd: 500 }));

  return { store, mine, theirs };
}

test("an admin reads every key's logs and a client reads only its own", async () => {
  const { store, mine } = await seeded();

  const all = await recentLogs(store, 100, scopeOf({ kind: "admin" }));
  expect(all.map((r) => r.id).sort()).toEqual(["anon", "m1", "m2", "t1"]);

  const own = await recentLogs(store, 100, scopeOf({ kind: "client", apiKeyId: mine.key.id }));
  // Zero of the other key's rows, asserted as an exact set rather than a count.
  expect(own.map((r) => r.id).sort()).toEqual(["m1", "m2"]);
  store.close();
});

test("a viewer reads what the admin reads", async () => {
  const { store } = await seeded();
  const admin = await recentLogs(store, 100, scopeOf({ kind: "admin" }));
  const viewer = await recentLogs(store, 100, scopeOf({ kind: "viewer" }));
  expect(viewer).toEqual(admin);
  store.close();
});

test("the default scope is unnarrowed, so existing callers are unchanged", async () => {
  const { store } = await seeded();
  // Both control functions take the scope last with a default. If that default
  // were ever a narrowed scope, every existing caller would silently start
  // reading nothing.
  expect((await recentLogs(store, 100)).length).toBe(4);
  expect((await queryUsage(deps(store), { groupBy: "provider" })).length).toBeGreaterThan(0);
  store.close();
});

test("a client's usage totals exclude every other key's spend", async () => {
  const { store, mine, theirs } = await seeded();

  const [all] = await queryUsage(deps(store), { groupBy: "provider" });
  expect(all?.costUsd).toBeCloseTo(603, 6);

  const [own] = await queryUsage(
    deps(store),
    { groupBy: "provider" },
    scopeOf({ kind: "client", apiKeyId: mine.key.id }),
  );
  expect(own?.requests).toBe(2);
  expect(own?.costUsd).toBeCloseTo(3, 6);

  const [other] = await queryUsage(
    deps(store),
    { groupBy: "provider" },
    scopeOf({ kind: "client", apiKeyId: theirs.key.id }),
  );
  expect(other?.costUsd).toBeCloseTo(100, 6);
  store.close();
});

/**
 * The query parameter a client controls must not reach the scope.
 *
 * `groupBy: "apiKey"` is the one dimension that would enumerate other keys, and
 * it is reachable from the URL. The scope is a WHERE, so it constrains the
 * grouped column too — this asserts the client cannot learn that another key
 * exists by asking the question a different way.
 */
test("a client grouping by apiKey sees exactly one key: its own", async () => {
  const { store, mine } = await seeded();

  const buckets = await queryUsage(
    deps(store),
    { groupBy: "apiKey", grain: "daily" },
    scopeOf({ kind: "client", apiKeyId: mine.key.id }),
  );
  expect(buckets.map((b) => b.key)).toEqual([mine.key.id]);
  store.close();
});

test("a client reads its own key summary, without the hash", async () => {
  const { store, mine } = await seeded();
  const summary = await readOwnKey(store, mine.key.id, NOW);

  expect(summary.id).toBe(mine.key.id);
  expect(summary.label).toBe("mine");
  expect(summary.prefix).toBe(mine.key.prefix);
  // The summary type omits it; asserted on the value because the type is not
  // what reaches the wire.
  expect(Object.keys(summary)).not.toContain("hash");
  expect(JSON.stringify(summary)).not.toContain(mine.key.hash);
  store.close();
});

test("reading a key that no longer exists is refused, not reported empty", async () => {
  const { store } = await seeded();
  // An empty summary reads as "a key with no limits", which is the opposite of
  // what a vanished key means.
  expect(readOwnKey(store, "not-a-key", NOW)).rejects.toThrow();
  store.close();
});

/**
 * Anonymous traffic belongs to no key, so no key may read it.
 *
 * At the raw grain `request_logs.api_key_id` is NULL and `= ?` never matches it,
 * which makes this look automatic. It is not: `usage_daily.api_key_id` is
 * `NOT NULL DEFAULT ''`, so at the daily grain untagged traffic sits under the
 * empty string and any scope carrying `""` reads all of it. Both grains are
 * asserted because only one of them was ever at risk.
 */
test("no scope reaches anonymous rows at either grain", async () => {
  const store = await memoryStore();
  await store.usage.append(
    requestLog({ id: "anon", at: NOW - 1_000, apiKeyId: null, costUsd: 500 }),
  );

  for (const grain of ["raw", "daily"] as const) {
    // The scope that used to be spelled "matches nothing".
    expect(
      await queryUsage(deps(store), { groupBy: "provider", grain }, { kind: "key", apiKeyId: "" }),
    ).toEqual([]);
    // And the one a machine principal produces, which is now its own arm.
    expect(await queryUsage(deps(store), { groupBy: "provider", grain }, scopeOf(MACHINE))).toEqual(
      [],
    );
  }

  expect(await recentLogs(store, 100, scopeOf(MACHINE))).toEqual([]);
  // The operator still sees it: it is their traffic, just not anyone's key.
  expect((await recentLogs(store, 100, scopeOf({ kind: "admin" }))).length).toBe(1);
  store.close();
});

test("a none scope reads nothing even where rows exist", async () => {
  const { store } = await seeded();
  expect(await queryUsage(deps(store), { groupBy: "provider" }, scopeOf(MACHINE))).toEqual([]);
  expect(await recentLogs(store, 100, scopeOf(MACHINE))).toEqual([]);
  store.close();
});

/**
 * Scoping rows is not scoping columns, and this is the case that proves it.
 *
 * `apiKeyId` narrows which rows are counted and does that correctly — but the
 * bucket key is whatever dimension the caller grouped on, returned verbatim. A
 * client asking `groupBy=credential` got its own rows back keyed by the
 * operator's account ids: one bucket per account that had served it. The row
 * filter cannot prevent that, because the question was never about rows.
 *
 * Found in review after the row-scoping tests were already green, which is the
 * point — every one of those tests passed while this was wide open.
 */
test("a narrowed scope cannot group by credential, at either grain", async () => {
  const { store, mine } = await seeded();
  const client = scopeOf({ kind: "client", apiKeyId: mine.key.id });

  for (const grain of ["raw", "daily"] as const) {
    expect(queryUsage(deps(store), { groupBy: "credential", grain }, client)).rejects.toThrow();
    // The second dimension too: `splitBy` reaches the same column.
    expect(
      queryUsage(deps(store), { groupBy: "model", splitBy: "credential", grain }, client),
    ).rejects.toThrow();
  }
  store.close();
});

test("the operator may still group by credential", async () => {
  const { store } = await seeded();
  // The restriction is a property of the scope, not of the dimension. An
  // installation-wide reader is exactly who that breakdown is for.
  for (const principal of [{ kind: "admin" } as const, { kind: "viewer" } as const]) {
    const buckets = await queryUsage(deps(store), { groupBy: "credential" }, scopeOf(principal));
    expect(buckets.length).toBeGreaterThan(0);
  }
  store.close();
});

test("the dimensions a client may still ask for keep working", async () => {
  const { store, mine } = await seeded();
  const client = scopeOf({ kind: "client", apiKeyId: mine.key.id });

  // Refusing `credential` must not turn into refusing everything: these name
  // the caller's own request or something already public to it.
  for (const groupBy of ["model", "provider", "requestedModel"] as const) {
    expect((await queryUsage(deps(store), { groupBy }, client)).length).toBeGreaterThan(0);
  }
  // `apiKey` under a key scope can only ever produce the caller's own id.
  const own = await queryUsage(deps(store), { groupBy: "apiKey", grain: "daily" }, client);
  expect(own.map((b) => b.key)).toEqual([mine.key.id]);
  store.close();
});
