import { expect, test } from "bun:test";
import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveKey } from "../src/encryption.ts";
import { createStore } from "../src/sqlite/store.ts";
import type { ApiKeyInput, Store } from "../src/types.ts";

const SECRET = "test-secret-value-for-unit-tests";

/**
 * A store on disk, because a swap replaces a file and an in-memory database has
 * no file to replace.
 */
async function tempStore(): Promise<{ store: Store; root: string; dbPath: string }> {
  const root = join(tmpdir(), `omni-swap-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const dbPath = join(root, "omnigateway.db");
  const store = await createStore({ path: dbPath, encryptionKey: await deriveKey(SECRET) });
  return { store, root, dbPath };
}

async function cleanup(store: Store, root: string): Promise<void> {
  store.close();
  await rm(root, { recursive: true, force: true });
}

function key(id: string): ApiKeyInput {
  return {
    id,
    label: id,
    prefix: `sk-omni-${id}`,
    hash: `hash-${id}`,
    modelAllowlist: null,
    limits: {},
    bodyLoggingOptOut: false,
  };
}

/**
 * Puts a different database at the store's path, the way a restore does: close
 * the handle, move the file in, drop the sidecars the old handle left.
 */
async function swapIn(store: Store, replacement: string): Promise<void> {
  store.close();
  await rm(`${store.databasePath}-wal`, { force: true });
  await rm(`${store.databasePath}-shm`, { force: true });
  await rename(replacement, store.databasePath);
  await store.reopen();
}

test("a repo captured before reopen reads the database that replaced it", async () => {
  const { store, root } = await tempStore();
  const replacement = join(root, "replacement.sqlite");
  try {
    // Captured by value, exactly as boot captures the store into its five
    // long-lived holders. Everything after this uses the old reference.
    const keys = store.keys;
    const config = store.config;
    await keys.create(key("before"));

    // A second database, built from a snapshot so it is schema-identical.
    await store.maintenance.snapshotTo(replacement);
    const other = await createStore({
      path: replacement,
      encryptionKey: await deriveKey(SECRET),
    });
    await other.keys.create(key("after"));
    await other.config.putSettings({ maxAttempts: 9 });
    other.close();

    await swapIn(store, replacement);

    expect((await keys.list()).map((k) => k.id).sort()).toEqual(["after", "before"]);
    expect((await config.getSettings()).maxAttempts).toBe(9);
    // The path is what it was; a swap replaces contents, not the installation.
    expect(store.databasePath).toBe(join(root, "omnigateway.db"));
  } finally {
    await cleanup(store, root);
  }
});

test("a routing subscriber registered before reopen still fires after", async () => {
  const { store, root } = await tempStore();
  const replacement = join(root, "replacement.sqlite");
  try {
    const changes: string[] = [];
    // Registered at boot, long before any restore, and never re-registered.
    const unsubscribe = store.routing.subscribe((change) => changes.push(change.type));

    await store.maintenance.snapshotTo(replacement);
    await swapIn(store, replacement);

    await store.config.putSettings({ maxAttempts: 4 });
    expect(changes).toEqual(["settingsChanged"]);

    unsubscribe();
    await store.config.putSettings({ maxAttempts: 5 });
    expect(changes).toEqual(["settingsChanged"]);
  } finally {
    await cleanup(store, root);
  }
});

test("reopen with no swap leaves the store usable, and close stays idempotent", async () => {
  const { store, root } = await tempStore();
  try {
    const keys = store.keys;
    await keys.create(key("k1"));

    await store.reopen();
    expect((await keys.list()).map((k) => k.id)).toEqual(["k1"]);
    expect(store.routing.version()).toBeGreaterThanOrEqual(0);

    store.close();
    // A restore closes before swapping and the caller closes again on the way
    // out; the second call must not throw on an already-closed handle.
    store.close();
    await store.reopen();
    expect((await keys.list()).map((k) => k.id)).toEqual(["k1"]);
  } finally {
    await cleanup(store, root);
  }
});
