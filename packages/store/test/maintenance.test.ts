import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveKey } from "../src/encryption.ts";
import { createStore } from "../src/sqlite/store.ts";
import type { RequestLog, Store } from "../src/types.ts";

/**
 * A store on disk, because `VACUUM INTO` writes a file and an in-memory
 * database has nowhere to write one to.
 */
async function tempStore(): Promise<{ store: Store; root: string; dbPath: string }> {
  const root = join(tmpdir(), `omni-maintenance-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const dbPath = join(root, "omnigateway.db");
  const store = await createStore({
    path: dbPath,
    encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
  });
  return { store, root, dbPath };
}

async function cleanup(store: Store, root: string): Promise<void> {
  store.close();
  await rm(root, { recursive: true, force: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const AT = Date.UTC(2026, 7, 18, 9, 0, 0);

/** A log row padded out, so a few hundred of them span many pages. */
function log(id: string): RequestLog {
  return {
    id,
    state: "pending",
    at: AT,
    apiKeyId: null,
    requestedModel: "m".repeat(4096),
    resolvedProvider: null,
    resolvedModel: null,
    credentialId: null,
    attempts: 0,
    status: 0,
    errorCode: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: null,
    durationMs: 0,
    costUsd: 0,
    degradations: [],
    rtkApplied: false,
    rtkFilterHits: 0,
    rtkOriginalCodeUnits: 0,
    rtkCompressedCodeUnits: 0,
    rtkEstimatedTokensSaved: 0,
    rtkFilters: [],
  };
}

/** Fills the file, then empties it, leaving pages on the freelist. */
async function churn(store: Store): Promise<void> {
  for (let i = 0; i < 300; i++) await store.usage.begin(log(`req_${i}`));
  await store.usage.prune(AT + 1);
}

test("store reports the path it was opened at", async () => {
  const { store, root, dbPath } = await tempStore();
  try {
    expect(store.databasePath).toBe(dbPath);
  } finally {
    await cleanup(store, root);
  }
});

test("stats reports page geometry and the applied schema version", async () => {
  const { store, root } = await tempStore();
  try {
    const stats = await store.maintenance.stats();

    // A page size is a power of two between 512 and 65536; anything else means
    // the pragma was not actually read.
    expect(stats.pageSize).toBeGreaterThanOrEqual(512);
    expect(Number.isInteger(Math.log2(stats.pageSize))).toBe(true);
    expect(stats.pageCount).toBeGreaterThan(0);
    expect(stats.freelistCount).toBe(0);
    // The highest migration id applied, which only ever grows.
    expect(stats.schemaVersion).toBeGreaterThanOrEqual(8);
  } finally {
    await cleanup(store, root);
  }
});

test("vacuum returns the freelist to the filesystem", async () => {
  const { store, root } = await tempStore();
  try {
    await churn(store);
    const before = await store.maintenance.stats();
    expect(before.freelistCount).toBeGreaterThan(0);

    await store.maintenance.vacuum();

    const after = await store.maintenance.stats();
    expect(after.freelistCount).toBe(0);
    expect(after.pageCount).toBeLessThan(before.pageCount);
    // The schema is untouched by a rewrite; only the geometry moves.
    expect(after.schemaVersion).toBe(before.schemaVersion);
  } finally {
    await cleanup(store, root);
  }
});

test("vacuum shrinks the database file itself, not only its page count", async () => {
  const { store, root, dbPath } = await tempStore();
  try {
    await churn(store);
    const before = (await stat(dbPath)).size;

    await store.maintenance.vacuum();

    // In WAL mode a rewrite lands in the log, so the page count falls while the
    // main file keeps every page it had. Callers report reclaimed bytes by
    // measuring this file, and an operator who compacts a database is told
    // about the disk they got back — so the checkpoint is part of the job, not
    // an optimisation to leave for whenever the log next rolls over.
    expect((await stat(dbPath)).size).toBeLessThan(before);
  } finally {
    await cleanup(store, root);
  }
});

test("a snapshot is a self-contained copy of what was committed", async () => {
  const { store, root } = await tempStore();
  const snapshot = join(root, "snap.sqlite");
  try {
    await store.keys.create({
      id: "k1",
      label: "laptop",
      prefix: "sk-omni-abcd",
      hash: "hash-1",
      modelAllowlist: null,
      rateLimitPerMin: null,
      bodyLoggingOptOut: false,
    });

    await store.maintenance.snapshotTo(snapshot);

    // The write-ahead log is folded in by `VACUUM INTO`, so a snapshot is one
    // file with no sidecar to carry alongside it.
    expect(await exists(`${snapshot}-wal`)).toBe(false);
    expect(await exists(`${snapshot}-shm`)).toBe(false);

    const copy = await createStore({
      path: snapshot,
      encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
    });
    try {
      expect((await copy.keys.list()).map((k) => k.id)).toEqual(["k1"]);
    } finally {
      copy.close();
    }

    // A row written after the snapshot stays out of it.
    await store.keys.create({
      id: "k2",
      label: "desktop",
      prefix: "sk-omni-efgh",
      hash: "hash-2",
      modelAllowlist: null,
      rateLimitPerMin: null,
      bodyLoggingOptOut: false,
    });
    const reread = await createStore({
      path: snapshot,
      encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
    });
    try {
      expect((await reread.keys.list()).map((k) => k.id)).toEqual(["k1"]);
    } finally {
      reread.close();
    }
  } finally {
    await cleanup(store, root);
  }
});

test("a destination path containing a quote is escaped, not interpolated", async () => {
  const { store, root } = await tempStore();
  // `VACUUM INTO` takes a SQL expression, so an unescaped apostrophe in a
  // directory name is a syntax error at best. Operators do have these.
  const snapshot = join(root, "rin's snapshot.sqlite");
  try {
    await store.maintenance.snapshotTo(snapshot);
    expect(await exists(snapshot)).toBe(true);
  } finally {
    await cleanup(store, root);
  }
});

test("inspect accepts a snapshot of this database", async () => {
  const { store, root } = await tempStore();
  const snapshot = join(root, "snap.sqlite");
  try {
    await store.keys.create({
      id: "k1",
      label: "laptop",
      prefix: "sk-omni-abcd",
      hash: "hash-1",
      modelAllowlist: null,
      rateLimitPerMin: null,
      bodyLoggingOptOut: false,
    });
    await store.maintenance.snapshotTo(snapshot);

    const seen = await store.maintenance.inspect(snapshot);

    expect(seen.ok).toBe(true);
    expect(seen.quickCheck).toBe("ok");
    expect(seen.tables).toContain("credentials");
    expect(seen.tables).toContain("migrations");
    // Counts are what an operator judges a restore by before committing to it.
    expect(seen.counts.api_keys).toBe(1);
    expect(seen.counts.credentials).toBe(0);
  } finally {
    await cleanup(store, root);
  }
});

test("inspect rejects a file that is not a database", async () => {
  const { store, root } = await tempStore();
  const junk = join(root, "notes.txt");
  try {
    await writeFile(junk, "these are not the pages you are looking for".repeat(64));

    const seen = await store.maintenance.inspect(junk);

    expect(seen.ok).toBe(false);
    expect(seen.quickCheck).toBe("unreadable");
    expect(seen.tables).toEqual([]);
    expect(seen.counts).toEqual({});
    // The message never carries the path: it is rendered to operators and logged.
    expect(seen.quickCheck).not.toContain(junk);
  } finally {
    await cleanup(store, root);
  }
});

test("inspect rejects a sound database that is not ours", async () => {
  const { store, root } = await tempStore();
  const foreign = join(root, "foreign.sqlite");
  try {
    const other = new Database(foreign, { create: true });
    other.run("CREATE TABLE recipes (id INTEGER PRIMARY KEY, name TEXT)");
    other.run("INSERT INTO recipes (name) VALUES ('gandr')");
    other.close();

    const seen = await store.maintenance.inspect(foreign);

    // Intact, and still not restorable: integrity alone is not identity.
    expect(seen.quickCheck).toBe("ok");
    expect(seen.ok).toBe(false);
    expect(seen.tables).toEqual(["recipes"]);
    expect(seen.counts).toEqual({});
    // Read-only means read-only: no journal is created beside the candidate.
    expect(await exists(`${foreign}-wal`)).toBe(false);
    expect(await exists(`${foreign}-shm`)).toBe(false);
  } finally {
    await cleanup(store, root);
  }
});

test("inspect rejects an ours-shaped database whose pages are damaged", async () => {
  const { store, root } = await tempStore();
  const snapshot = join(root, "snap.sqlite");
  try {
    await churn(store);
    await store.maintenance.snapshotTo(snapshot);
    expect((await store.maintenance.inspect(snapshot)).ok).toBe(true);

    // Overwrite pages past the header, so the file still opens and still
    // declares our schema but no longer holds a consistent b-tree.
    const bytes = new Uint8Array(await readFile(snapshot));
    bytes.fill(0x5a, 4096, Math.min(bytes.length, 40_960));
    await writeFile(snapshot, bytes);

    const seen = await store.maintenance.inspect(snapshot);

    expect(seen.ok).toBe(false);
    expect(seen.quickCheck).not.toBe("ok");
  } finally {
    await cleanup(store, root);
  }
});
