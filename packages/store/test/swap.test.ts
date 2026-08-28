import { expect, test } from "bun:test";
import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveKey } from "../src/encryption.ts";
import { createStore } from "../src/sqlite/store.ts";
import type { ApiKeyInput, RequestLog, Store } from "../src/types.ts";

const SECRET = "test-secret-value-for-unit-tests";

/** A complete row, so a schema change breaks here once rather than in each test. */
function logRow(id: string, at: number, apiKeyId: string | null): RequestLog {
  return {
    id,
    state: "done",
    at,
    apiKeyId,
    requestedModel: "fast",
    resolvedProvider: "anthropic",
    resolvedModel: "claude-opus-4",
    credentialId: "c1",
    attempts: 1,
    status: 200,
    errorCode: null,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: 100,
    durationMs: 200,
    costUsd: 0.001,
    degradations: [],
    rtkApplied: false,
    rtkFilterHits: 0,
    rtkOriginalCodeUnits: 0,
    rtkCompressedCodeUnits: 0,
    rtkEstimatedTokensSaved: 0,
    rtkFilters: [],
  };
}

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

/**
 * Every forwarder passes on every argument it was handed.
 *
 * The swap layer hand-writes one arrow per repo method, spelling out the
 * parameters. Dropping one is not a type error — an arrow of lower arity still
 * satisfies the interface — so the argument simply vanishes and the call
 * succeeds with a default. `usage.recent` shipped that way for one commit while
 * its second parameter carried the API-key scope: the forwarder passed only
 * `limit`, so a scoped read silently returned every key's rows.
 *
 * Reading the source is the only way to see it. A behavioural test catches the
 * method it covers and says nothing about the next one added.
 */
test("no repo forwarder drops an argument the source hands it", async () => {
  const src = await Bun.file(new URL("../src/sqlite/store.ts", import.meta.url)).text();
  const forwarder = /^ {6}(\w+): \(([^)]*)\) => handle\.(\w+)\.(\w+)\(([^)]*)\)/gm;
  const count = (s: string): number => (s.trim() === "" ? 0 : s.split(",").length);

  const dropped: string[] = [];
  let seen = 0;
  for (const m of src.matchAll(forwarder)) {
    const [, name, params, repo, , args] = m;
    seen += 1;
    if (count(params ?? "") !== count(args ?? "")) dropped.push(`${repo}.${name}`);
  }

  // Asserted first, because zero forwarders matched is also what a regex that
  // stopped matching the file's formatting reports, and it would report it as
  // a pass.
  expect(seen).toBeGreaterThan(30);
  expect(dropped).toEqual([]);
});

/**
 * A scoped read still narrows after the database underneath it is replaced.
 *
 * The forwarder test above reads the source and proves no arrow drops an
 * argument. This is the behavioural half: a repo captured before the swap must
 * still pass the scope through to the handle that replaced it. The two failures
 * look identical from outside — every row comes back — and only one of them is
 * visible to a regex.
 */
test("a usage repo captured before reopen still scopes to one key after it", async () => {
  const { store, root } = await tempStore();
  const replacement = join(root, "replacement.sqlite");
  try {
    // Captured by value, as boot captures the store into its long-lived holders.
    const usage = store.usage;
    const now = Date.now();
    await usage.append(logRow("before-mine", now - 3_000, "k1"));
    await usage.append(logRow("before-theirs", now - 2_000, "k2"));
    expect((await usage.recent(10, "k1")).map((r) => r.id)).toEqual(["before-mine"]);

    // A different database at the same path, carrying both keys' traffic again.
    const other = await createStore({
      path: replacement,
      encryptionKey: await deriveKey(SECRET),
    });
    await other.usage.append(logRow("after-mine", now - 1_000, "k1"));
    await other.usage.append(logRow("after-theirs", now - 500, "k2"));
    other.close();

    await swapIn(store, replacement);

    // The old reference, the new database, and still one key's rows.
    expect((await usage.recent(10, "k1")).map((r) => r.id)).toEqual(["after-mine"]);
    expect(await usage.recent(10, "nobody")).toEqual([]);
    // Unscoped still reads everything, so this is not passing by reading none.
    expect((await usage.recent(10)).map((r) => r.id).sort()).toEqual([
      "after-mine",
      "after-theirs",
    ]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
