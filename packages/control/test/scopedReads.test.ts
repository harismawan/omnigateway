import { expect, test } from "bun:test";
import { memoryStore, requestLog, seedApiKey } from "@omni/testkit";
import { readOwnKey } from "../src/keys.ts";
import { scopeOf } from "../src/principal.ts";
import { queryUsage, recentLogs } from "../src/usage.ts";

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
