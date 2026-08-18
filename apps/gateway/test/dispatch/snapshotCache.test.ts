import { expect, test } from "bun:test";
import { healthKey } from "@omni/router";
import { createStore, deriveKey } from "@omni/store";
import { memoryStore, seedCredential } from "@omni/testkit";
import { createRoutingSnapshotCache } from "../../src/dispatch/snapshotCache.ts";

async function seedRoutingStore() {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await store.config.putModel({
    id: "fast",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-4",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 15, output: 75 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
  return store;
}

test("unchanged reads reuse one routing snapshot build", async () => {
  const store = await seedRoutingStore();
  const listRouting = store.credentials.listRouting.bind(store.credentials);
  let builds = 0;
  store.credentials.listRouting = async () => {
    builds++;
    return listRouting();
  };
  const cache = createRoutingSnapshotCache(store);

  const first = await cache.get(100);
  const second = await cache.get(200);

  expect(second).toBe(first);
  expect(builds).toBe(1);
  cache.close();
  store.close();
});

test("concurrent cold reads share one snapshot build", async () => {
  const store = await seedRoutingStore();
  const listRouting = store.credentials.listRouting.bind(store.credentials);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let builds = 0;
  store.credentials.listRouting = async () => {
    builds++;
    await gate;
    return listRouting();
  };
  const cache = createRoutingSnapshotCache(store);

  const first = cache.get(100);
  const second = cache.get(100);
  release?.();

  expect(await second).toBe(await first);
  expect(builds).toBe(1);
  cache.close();
  store.close();
});

test("local health writes patch cached health without rebuilding", async () => {
  const store = await seedRoutingStore();
  const listRouting = store.credentials.listRouting.bind(store.credentials);
  let builds = 0;
  store.credentials.listRouting = async () => {
    builds++;
    return listRouting();
  };
  const cache = createRoutingSnapshotCache(store);
  const first = await cache.get(100);

  await store.credentials.saveHealth([
    {
      credentialId: "c1",
      model: "claude-opus-4",
      breakerState: "open",
      consecutiveFailures: 3,
      openedAt: 200,
      rateLimitedUntil: null,
      ewmaTtftMs: 300,
      lastUsedAt: 200,
    },
  ]);
  const second = await cache.get(200);

  expect(second).not.toBe(first);
  expect(second.health.get(healthKey("c1", "claude-opus-4"))?.breakerState).toBe("open");
  expect(builds).toBe(1);
  cache.close();
  store.close();
});

test("local quota writes replace one credential's cached windows", async () => {
  const store = await seedRoutingStore();
  await store.credentials.saveQuota([
    {
      credentialId: "c1",
      windowType: "fiveHour",
      startsAt: 0,
      used: 10,
      limit: 100,
      resetsAt: 1000,
      observedAt: 10,
      windowMs: null,
    },
  ]);
  const cache = createRoutingSnapshotCache(store);
  await cache.get(100);

  await store.credentials.saveQuota([
    {
      credentialId: "c1",
      windowType: "weekly",
      startsAt: 0,
      used: 25,
      limit: 100,
      resetsAt: 2000,
      observedAt: 20,
      windowMs: null,
    },
  ]);
  const snapshot = await cache.get(200);

  expect(snapshot.quota.get("c1")).toEqual([
    {
      credentialId: "c1",
      windowType: "weekly",
      startsAt: 0,
      used: 25,
      limit: 100,
      resetsAt: 2000,
      observedAt: 20,
      windowMs: null,
    },
  ]);
  cache.close();
  store.close();
});

test("local credential changes rebuild before returning", async () => {
  const store = await seedRoutingStore();
  const cache = createRoutingSnapshotCache(store);
  const first = await cache.get(100);

  await store.credentials.update("c1", { enabled: false });
  const second = await cache.get(200);

  expect(second).not.toBe(first);
  expect(second.credentials[0]?.enabled).toBe(false);
  cache.close();
  store.close();
});

test("a local write during rebuild cannot be hidden by its completion", async () => {
  const store = await seedRoutingStore();
  const cache = createRoutingSnapshotCache(store);
  await cache.get(100);
  await store.config.putSettings({ maxAttempts: 4 });

  const listRouting = store.credentials.listRouting.bind(store.credentials);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocked = false;
  store.credentials.listRouting = async () => {
    const rows = await listRouting();
    if (!blocked) {
      blocked = true;
      await gate;
    }
    return rows;
  };

  const rebuilding = cache.get(200);
  await Promise.resolve();
  await store.credentials.update("c1", { enabled: false });
  release?.();
  const snapshot = await rebuilding;

  expect(snapshot.credentials[0]?.enabled).toBe(false);
  cache.close();
  store.close();
});

test("a failed stale rebuild is retried and never serves old state", async () => {
  const store = await seedRoutingStore();
  const cache = createRoutingSnapshotCache(store);
  await cache.get(100);
  await store.config.putSettings({ maxAttempts: 5 });

  const listRouting = store.credentials.listRouting.bind(store.credentials);
  let fail = true;
  store.credentials.listRouting = async () => {
    if (fail) {
      fail = false;
      throw new Error("read failed");
    }
    return listRouting();
  };

  expect(cache.get(200)).rejects.toThrow("read failed");
  expect((await cache.get(300)).settings.maxAttempts).toBe(5);
  cache.close();
  store.close();
});

test("another SQLite connection invalidates cache before next read", async () => {
  const path = `/tmp/omnigateway-routing-cache-${crypto.randomUUID()}.db`;
  const key = await deriveKey("test-secret-value-for-unit-tests");
  const first = await createStore({ path, encryptionKey: key });
  const second = await createStore({ path, encryptionKey: key });
  const cache = createRoutingSnapshotCache(first);
  expect((await cache.get(100)).models.size).toBe(0);

  await second.config.putModel({
    id: "external",
    strategy: "priority",
    isAlias: false,
    targets: [],
  });

  expect((await cache.get(200)).models.has("external")).toBe(true);
  cache.close();
  first.close();
  second.close();
  await Bun.file(path).delete();
});

/**
 * The one change the version check cannot see.
 *
 * Staleness is decided by SQLite's `data_version`, which is a property of the
 * open connection — so a restore, which closes the handle and opens a new one
 * over a different file, is exactly the change that can leave the counter
 * reading the same as before. Whoever swapped the file says so explicitly.
 */
test("an explicit invalidation rebuilds the snapshot even when the version agrees", async () => {
  const store = await seedRoutingStore();
  const cache = createRoutingSnapshotCache(store);
  const first = await cache.get(100);
  expect(await cache.get(200)).toBe(first);

  cache.invalidate();

  const rebuilt = await cache.get(300);
  expect(rebuilt).not.toBe(first);
  expect(rebuilt.models.has("fast")).toBe(true);
  cache.close();
  store.close();
});
