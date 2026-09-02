import { afterAll, afterEach, describe, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { deriveKey } from "../../src/encryption.ts";
import { createPostgresStore } from "../../src/postgres/store.ts";
import { createStore } from "../../src/sqlite/store.ts";
import type { Store } from "../../src/types.ts";

/**
 * One database as a test sees it: `fresh` wipes it and opens a store, `sibling`
 * opens a second store over the same database without wiping — what the
 * node-scoping tests need, since two processes sharing one database is the
 * case that scoping exists for.
 */
export type Backend = {
  name: "sqlite" | "postgres";
  fresh(nodeId?: string): Promise<Store>;
  sibling(nodeId?: string): Promise<Store>;
};

const SECRET = "test-secret-value-for-unit-tests";

/**
 * Registers `define` once per backend. The SQLite suite always runs; the
 * Postgres one runs when `OMNI_TEST_DATABASE_URL` names a server and is
 * skipped — visibly, one line per file — when it does not. Every store a test
 * opens is closed after it, and every SQLite file removed after the file.
 */
export function forEachStore(define: (backend: Backend) => void): void {
  const opened: Store[] = [];
  const track = (store: Store): Store => {
    opened.push(store);
    return store;
  };
  afterEach(() => {
    for (const store of opened.splice(0)) store.close();
  });

  describe("sqlite", () => {
    const files: string[] = [];
    let path = "";
    afterAll(async () => {
      for (const file of files) await rm(file, { force: true });
    });
    const open = async (nodeId: string | undefined): Promise<Store> =>
      track(
        await createStore({
          path,
          encryptionKey: await deriveKey(SECRET),
          ...(nodeId === undefined ? {} : { nodeId }),
        }),
      );
    define({
      name: "sqlite",
      async fresh(nodeId) {
        // A file rather than `:memory:`, so `sibling` can open the same database.
        path = join(tmpdir(), `omni-contract-${crypto.randomUUID()}.sqlite`);
        files.push(path, `${path}-wal`, `${path}-shm`);
        return open(nodeId);
      },
      sibling: (nodeId) => open(nodeId),
    });
  });

  const url = process.env.OMNI_TEST_DATABASE_URL;
  if (url === undefined || url === "") {
    test.skip("postgres: OMNI_TEST_DATABASE_URL unset, Postgres contract suite not run", () => {});
    return;
  }

  describe("postgres", () => {
    const open = async (nodeId: string | undefined): Promise<Store> =>
      track(
        await createPostgresStore({
          url,
          encryptionKey: await deriveKey(SECRET),
          ...(nodeId === undefined ? {} : { nodeId }),
        }),
      );
    define({
      name: "postgres",
      async fresh(nodeId) {
        const admin = new SQL({ url, max: 1 });
        try {
          await admin.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
        } finally {
          await admin.close();
        }
        return open(nodeId);
      },
      sibling: (nodeId) => open(nodeId),
    });
  });
}

/** A complete row, so a schema change breaks here once rather than in each test. */
export function logRow(
  overrides: Partial<import("../../src/types.ts").RequestLog> & { id: string },
): import("../../src/types.ts").RequestLog {
  return {
    state: "done",
    at: 1_700_000_000_000,
    apiKeyId: "k1",
    requestedModel: "fast",
    resolvedProvider: "anthropic",
    resolvedModel: "claude-opus-4",
    credentialId: "c1",
    attempts: 1,
    status: 200,
    errorCode: null,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
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
    ...overrides,
  };
}
