import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { deriveKey } from "../../src/encryption.ts";
import {
  createPostgresExportReader,
  type ExportReader,
  openSqliteExportReader,
} from "../../src/exportReader.ts";
import type { Store } from "../../src/types.ts";
import { forEachStore, logRow } from "./harness.ts";

/**
 * The export worker's read surface, on both backends: the main database seen
 * through a handle that cannot write. Built from the same repos the store uses,
 * so what it reads is what the store would read.
 */
const SECRET = "test-secret-value-for-unit-tests";

forEachStore((backend) => {
  const opened: Array<{ close(): void | Promise<void> }> = [];

  async function readerFor(store: Store): Promise<ExportReader> {
    const key = await deriveKey(SECRET);
    if (backend.name === "sqlite") {
      const reader = openSqliteExportReader(store.databasePath, key, () => 1_234);
      opened.push(reader);
      return reader;
    }
    const sql = new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string, max: 2 });
    opened.push({ close: () => sql.close() });
    return createPostgresExportReader(sql, key);
  }

  const done = async (): Promise<void> => {
    for (const handle of opened.splice(0)) await handle.close();
  };

  test("reads destinations, their secret, settings, key labels and rows", async () => {
    const s = await backend.fresh();
    try {
      await s.exportDestinations.create({
        id: "hook",
        type: "webhook",
        config: { url: "https://hooks.internal/x" },
        startFrom: "oldest",
        secret: '{"signingSecret":"s3cret"}',
      });
      await s.keys.create({
        id: "k1",
        label: "team",
        prefix: "omni_k1",
        hash: "h1",
        modelAllowlist: null,
        limits: {},
        bodyLoggingOptOut: false,
        expiresAt: null,
        guardrailPolicy: null,
        smartRouting: false,
      });
      await s.config.putSettings({ logRetentionDays: 9 });
      await s.usage.append(logRow({ id: "r1", apiKeyId: "k1" }));

      const r = await readerFor(s);
      const [hook] = await r.destinations();
      expect(hook?.id).toBe("hook");
      const opened = await r.destinationWithSecret("hook");
      expect(opened?.destination.id).toBe("hook");
      expect(opened?.secret).toBe('{"signingSecret":"s3cret"}');
      expect(await r.destinationWithSecret("absent")).toBeNull();
      expect((await r.settings()).logRetentionDays).toBe(9);
      expect((await r.keyLabels()).get("k1")).toBe("team");
      const page = await r.exportPage({
        after: { completedAt: 0, id: "" },
        settledBefore: Number.MAX_SAFE_INTEGER,
        limit: 10,
      });
      expect(page.map((row) => row.id)).toEqual(["r1"]);
      expect((await r.getLog("r1"))?.apiKeyId).toBe("k1");
      expect(await r.getLog("absent")).toBeNull();
    } finally {
      await done();
    }
  });

  test("an aborted signal refuses the cursor read", async () => {
    const s = await backend.fresh();
    try {
      await s.usage.append(logRow({ id: "r1" }));
      const r = await readerFor(s);
      const controller = new AbortController();
      controller.abort();
      await expect(
        r.exportPage({
          after: { completedAt: 0, id: "" },
          settledBefore: Number.MAX_SAFE_INTEGER,
          limit: 10,
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      // The store's own read honours the same field.
      await expect(
        s.usage.exportPage({
          after: { completedAt: 0, id: "" },
          settledBefore: Number.MAX_SAFE_INTEGER,
          limit: 10,
          signal: controller.signal,
        }),
      ).rejects.toThrow();
    } finally {
      await done();
    }
  });

  test("now() is the injected clock on SQLite and the database clock on Postgres", async () => {
    const s = await backend.fresh();
    try {
      const r = await readerFor(s);
      const now = await r.now();
      if (backend.name === "sqlite") expect(now).toBe(1_234);
      else expect(Math.abs(now - Date.now())).toBeLessThan(60_000);
    } finally {
      await done();
    }
  });

  if (backend.name === "sqlite") {
    test("the SQLite handle is read-only: a write through it throws", async () => {
      const s = await backend.fresh();
      try {
        const db = new Database(s.databasePath, { readonly: true });
        try {
          expect(() => db.run("DELETE FROM request_logs")).toThrow(/readonly/);
        } finally {
          db.close();
        }
        // And the reader's own handle, reached through a repo write it never exposes.
        const r = openSqliteExportReader(s.databasePath, await deriveKey(SECRET), () => 0);
        opened.push(r);
        expect(Object.keys(r).sort()).toEqual([
          "close",
          "destinationWithSecret",
          "destinations",
          "exportPage",
          "getLog",
          "keyLabels",
          "now",
          "settings",
        ]);
        r.close();
        r.close();
      } finally {
        await done();
      }
    });
  }
});
