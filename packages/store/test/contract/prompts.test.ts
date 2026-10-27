import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { deriveKey } from "../../src/encryption.ts";
import { createPostgresExportReader, openSqliteExportReader } from "../../src/exportReader.ts";
import type { PromptRow } from "../../src/promptRow.ts";
import { openDb } from "../../src/sqlite/db.ts";
import { createPromptRepo } from "../../src/sqlite/prompts.ts";
import type { ApiKeyInput, PromptCreate, PromptDetail } from "../../src/types.ts";
import { exec, forEachStore, logRow } from "./harness.ts";

const prompt = (id = "team", activate = true): PromptCreate => ({
  id,
  name: id,
  description: null,
  text: "  conventions",
  note: null,
  activate,
});
const key = (id: string): ApiKeyInput => ({
  id,
  label: id,
  prefix: "sk-test",
  hash: id,
  modelAllowlist: null,
  limits: {},
  bodyLoggingOptOut: false,
  expiresAt: null,
  guardrailPolicy: null,
  smartRouting: false,
});
const save = { text: "next", note: "draft", activate: false };

async function waitForPromptWaiters(sql: SQL, count: number): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const rows = await sql.unsafe<{ n: string }[]>(
      `SELECT COUNT(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = (hashtext('omni:prompt-management')::bigint & 4294967295)::oid`,
    );
    if (Number(rows[0]?.n) >= count) return;
  }
  throw new Error("management-lock waiter never appeared");
}

forEachStore((backend) => {
  test("library drafts, metadata, immutable versions and rollback", async () => {
    const store = await backend.fresh();
    const changes: string[] = [];
    store.routing.subscribe((change) => changes.push(change.type));
    expect(await store.prompts.list()).toEqual([]);
    const first = await store.prompts.create(prompt("team", false));
    expect(first.activeVersion).toBeNull();
    expect(first.versions[0]?.text).toBe("  conventions");
    expect(await store.prompts.listActive()).toEqual([]);
    await store.prompts.update("team", { name: "Team rules", description: "shared" });
    await store.prompts.activate("team", 1);
    expect((await store.prompts.saveVersion("team", save)).version).toBe(2);
    expect((await store.prompts.listActive())[0]?.text).toBe("  conventions");
    await store.prompts.activate("team", 2);
    await store.prompts.activate("team", 1);
    const detail = await store.prompts.get("team");
    expect(detail?.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(detail?.activeVersion).toBe(1);
    expect(await store.prompts.list()).toEqual([
      {
        id: "team",
        name: "Team rules",
        description: "shared",
        activeVersion: 1,
        createdAt: first.createdAt,
        updatedAt: detail?.updatedAt ?? 0,
      },
    ]);
    const count = changes.length;
    await expect(store.prompts.create(prompt())).rejects.toMatchObject({ kind: "exists" });
    await expect(store.prompts.activate("team", 99)).rejects.toMatchObject({
      kind: "version-missing",
    });
    await expect(store.prompts.saveVersion("absent", save)).rejects.toMatchObject({
      kind: "missing",
    });
    expect(changes).toEqual(Array(count).fill("promptsChanged"));
    await expect(
      exec(
        backend,
        store,
        "INSERT INTO prompt_versions (prompt_id, version, text, note, created_at) VALUES ('team',1,'overwrite',NULL,0)",
      ),
    ).rejects.toThrow();
    expect((await store.prompts.get("team"))?.versions[1]?.text).toBe("  conventions");
    await store.prompts.remove("team");
    expect(await store.prompts.get("team")).toBeNull();
  });

  test("pruning retains active v1, monotone numbering and sibling allocation", async () => {
    const store = await backend.fresh();
    await store.prompts.create(prompt());
    for (let i = 0; i < 100; i++) await store.prompts.saveVersion("team", save);
    const detail = (await store.prompts.get("team")) as PromptDetail;
    expect(detail.versions).toHaveLength(100);
    expect(detail.activeVersion).toBe(1);
    expect(detail.versions.some((v) => v.version === 2)).toBe(false);
    const sibling = await backend.sibling();
    const versions = await Promise.all([
      store.prompts.saveVersion("team", save),
      sibling.prompts.saveVersion("team", save),
    ]);
    expect(versions.map((v) => v.version).sort((a, b) => a - b)).toEqual([102, 103]);
    const before = await store.prompts.get("team");
    if (!before) throw new Error("missing prompt before race");
    const target = before?.versions.findLast((v) => v.version !== before.activeVersion)?.version;
    if (target === undefined) throw new Error("missing retained nonactive version");
    expect(before?.versions.some((v) => v.version === target)).toBe(true);
    const [activation, pruning] = await Promise.allSettled([
      store.prompts.activate("team", target),
      sibling.prompts.saveVersion("team", save),
    ]);
    expect(pruning.status).toBe("fulfilled");
    if (activation.status === "rejected") {
      expect(activation.reason).toMatchObject({ kind: "version-missing" });
    }
    const final = (await store.prompts.get("team")) as PromptDetail;
    expect(final.versions).toHaveLength(100);
    expect(final.versions.some((v) => v.version === final.activeVersion)).toBe(true);
    expect(final.activeVersion).toBe(
      activation.status === "fulfilled" ? target : before.activeVersion,
    );
    expect(final.versions.some((v) => v.version === target)).toBe(
      activation.status === "fulfilled",
    );
  });

  test("concurrent creates at 49 enforce cap", async () => {
    const store = await backend.fresh();
    for (let i = 0; i < 49; i++) await store.prompts.create(prompt(`p-${i}`));
    const sibling = await backend.sibling();
    const outcomes = await Promise.allSettled([
      store.prompts.create(prompt("last-a")),
      sibling.prompts.create(prompt("last-b")),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((o) => o.status === "rejected")).toMatchObject({
      reason: { kind: "limit" },
    });
    expect(await store.prompts.list()).toHaveLength(50);
  });

  test("assigned drafts include all explicit keys and block deletion", async () => {
    const store = await backend.fresh();
    await store.prompts.create(prompt("team", false));
    await store.config.putSettings({ prompts: ["team"] });
    await store.keys.create({
      ...key("expired"),
      expiresAt: 1,
      prompts: { ids: ["team"], inheritGlobal: false },
    });
    await store.keys.create(key("inherited"));
    await store.keys.create({ ...key("revoked"), prompts: { ids: ["team"], inheritGlobal: true } });
    await store.keys.revoke("revoked");
    const assignments = { global: true, keyIds: ["expired", "revoked"] };
    expect(await store.prompts.assignments("team")).toEqual(assignments);
    await expect(store.prompts.remove("team")).rejects.toMatchObject({
      kind: "assigned",
      assignments,
    });
  });

  test("assignment defaults, tolerant reads and locked missing checks", async () => {
    const store = await backend.fresh();
    const row = await store.keys.create(key("k"));
    expect(row.prompts).toEqual({ ids: [], inheritGlobal: true });
    await expect(store.config.putSettings({ prompts: ["gone"] })).rejects.toMatchObject({
      kind: "missing",
    });
    await expect(
      store.keys.create({ ...key("new"), prompts: { ids: ["gone"], inheritGlobal: true } }),
    ).rejects.toMatchObject({ kind: "missing" });
    await expect(
      store.keys.setPrompts("k", { ids: ["gone"], inheritGlobal: true }),
    ).rejects.toMatchObject({ kind: "missing" });
    await expect(
      store.keys.importRow({
        ...row,
        id: "imported",
        hash: "imported",
        prompts: { ids: ["gone"], inheritGlobal: true },
      }),
    ).rejects.toMatchObject({ kind: "missing" });
    await store.config.putSettings({});
    await exec(
      backend,
      store,
      `UPDATE settings SET value = '{"prompts":["gone"]}' WHERE key = 'settings'`,
      `UPDATE api_keys SET prompts = '{"ids":["gone"],"inheritGlobal":false}' WHERE id = 'k'`,
    );
    expect((await store.config.putSettings({ maxAttempts: 4 })).prompts).toEqual(["gone"]);
    await store.keys.setPrompts("k", { ids: ["gone"], inheritGlobal: true });
    for (const raw of ["NULL", "'bad json'", "'[]'"]) {
      await exec(backend, store, `UPDATE api_keys SET prompts = ${raw} WHERE id = 'k'`);
      expect((await store.keys.get("k"))?.prompts).toEqual({ ids: [], inheritGlobal: true });
    }
    await exec(
      backend,
      store,
      `UPDATE api_keys SET prompts = '{"ids":["team","team","BAD","ponytail-full","ponytail-lite","ponytail-invalid"],"inheritGlobal":false}' WHERE id = 'k'`,
    );
    expect((await store.keys.list())[0]?.prompts).toEqual({
      ids: ["team", "ponytail-full"],
      inheritGlobal: false,
    });
  });

  test("exact import preserves gaps and timestamps, rejects invalid pointer atomically", async () => {
    const store = await backend.fresh();
    const row: PromptDetail = {
      id: "team",
      name: "Team",
      description: "copy",
      activeVersion: 1,
      createdAt: 10,
      updatedAt: 30,
      versions: [
        { promptId: "team", version: 11, text: "draft", note: "n", createdAt: 30 },
        { promptId: "team", version: 1, text: "active", note: null, createdAt: 10 },
      ],
    };
    await store.prompts.importRow(row);
    expect(await store.prompts.get("team")).toEqual(row);
    expect((await store.prompts.saveVersion("team", save)).version).toBe(12);
    await expect(
      store.prompts.importRow({
        ...row,
        id: "invalid",
        activeVersion: 2,
        versions: row.versions.map((v) => ({ ...v, promptId: "invalid" })),
      }),
    ).rejects.toMatchObject({ kind: "version-missing" });
    expect(await store.prompts.get("invalid")).toBeNull();
    const changes: string[] = [];
    store.routing.subscribe((change) => changes.push(change.type));
    const original = row.versions[0];
    if (!original) throw new Error("missing fixture version");
    const duplicate = { ...original, promptId: "broken" };
    await expect(
      store.prompts.importRow({
        ...row,
        id: "broken",
        activeVersion: null,
        versions: [duplicate, duplicate],
      }),
    ).rejects.toThrow();
    expect(await store.prompts.get("broken")).toBeNull();
    expect(changes).toEqual([]);
    await expect(store.prompts.importRow(row)).rejects.toMatchObject({ kind: "exists" });
  });

  for (const writer of ["global", "create", "import", "setter"] as const) {
    test(`delete versus ${writer} assignment never leaves dangling references`, async () => {
      const store = await backend.fresh();
      const sibling = await backend.sibling();
      await store.prompts.create(prompt());
      const k = await store.keys.create(key("k"));
      const assignment = { ids: ["team"], inheritGlobal: false };
      const write = () =>
        writer === "global"
          ? sibling.config.putSettings({ prompts: ["team"] })
          : writer === "create"
            ? sibling.keys.create({ ...key("new"), prompts: assignment })
            : writer === "import"
              ? sibling.keys.importRow({ ...k, id: "new", hash: "new", prompts: assignment })
              : sibling.keys.setPrompts("k", assignment);
      const results = await Promise.allSettled([store.prompts.remove("team"), write()]);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      if (!(await store.prompts.get("team")))
        expect(await store.prompts.assignments("team")).toEqual({ global: false, keyIds: [] });
    });
  }

  test("applied log ids round trip", async () => {
    const store = await backend.fresh();
    const log = logRow({ id: "logged", prompts: ["team@3"] });
    await store.usage.begin(log);
    expect((await store.usage.get(log.id))?.prompts).toEqual(log.prompts);
    await store.usage.route(log.id, { provider: "anthropic", model: "routed", credentialId: "c" });
    expect((await store.usage.get(log.id))?.prompts).toEqual(log.prompts);
    await store.usage.append(log);
    expect((await store.usage.recent(1))[0]?.prompts).toEqual(log.prompts);
    expect((await store.usage.scan(null, 10))[0]?.prompts).toEqual(log.prompts);
    expect((await store.usage.page({ limit: 10, cursor: null })).logs[0]?.prompts).toEqual(
      log.prompts,
    );
    const encryptionKey = await deriveKey("test-secret-value-for-unit-tests");
    const sql =
      backend.name === "postgres"
        ? new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string })
        : null;
    const reader = sql
      ? createPostgresExportReader(sql, encryptionKey)
      : openSqliteExportReader(store.databasePath, encryptionKey, Date.now);
    try {
      expect((await reader.getLog(log.id))?.prompts).toEqual(log.prompts);
      expect(
        (
          await reader.exportPage({
            after: { completedAt: 0, id: "" },
            settledBefore: Number.MAX_SAFE_INTEGER,
            limit: 10,
          })
        )[0]?.prompts,
      ).toEqual(log.prompts);
    } finally {
      reader.close();
      await sql?.close();
    }
  });

  if (backend.name === "postgres") {
    for (const first of ["activation", "pruning"] as const) {
      test(`oldest retained activation versus pruning: ${first} wins management lock`, async () => {
        const store = await backend.fresh();
        const sibling = await backend.sibling();
        await store.prompts.create(prompt());
        for (let i = 0; i < 99; i++) await store.prompts.saveVersion("team", save);
        const before = await store.prompts.get("team");
        const target = before?.versions.findLast(
          (v) => v.version !== before.activeVersion,
        )?.version;
        if (target === undefined) throw new Error("missing retained nonactive version");
        expect(before?.versions).toHaveLength(100);
        expect(target).toBe(2);
        expect(before?.versions.some((v) => v.version === target)).toBe(true);
        const sql = new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string });
        const conn = await sql.reserve();
        try {
          await conn.unsafe("BEGIN");
          await conn.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
            "omni:prompt-management",
          ]);
          const activate = () => Promise.allSettled([store.prompts.activate("team", target)]);
          const prune = () => Promise.allSettled([sibling.prompts.saveVersion("team", save)]);
          const leading = first === "activation" ? activate() : prune();
          await waitForPromptWaiters(sql, 1);
          const trailing = first === "activation" ? prune() : activate();
          await waitForPromptWaiters(sql, 2);
          await conn.unsafe("COMMIT");
          const [leadingResult] = await leading;
          const [trailingResult] = await trailing;
          const activation = first === "activation" ? leadingResult : trailingResult;
          const pruning = first === "pruning" ? leadingResult : trailingResult;
          expect(pruning).toMatchObject({ status: "fulfilled", value: { version: 101 } });
          if (first === "activation") {
            expect(activation).toMatchObject({
              status: "fulfilled",
              value: { activeVersion: target },
            });
          } else {
            expect(activation).toMatchObject({
              status: "rejected",
              reason: { kind: "version-missing" },
            });
          }
          const final = await store.prompts.get("team");
          expect(final?.versions).toHaveLength(100);
          expect(final?.activeVersion).toBe(
            first === "activation" ? target : before?.activeVersion,
          );
          expect(final?.versions.some((v) => v.version === final.activeVersion)).toBe(true);
          expect(final?.versions.some((v) => v.version === target)).toBe(first === "activation");
        } finally {
          await conn.unsafe("ROLLBACK");
          conn.release();
          await sql.close();
        }
      });
    }

    for (const writer of ["global", "create", "import", "setter"] as const) {
      test(`management lock precedes ${writer} row/config locks and arbitrates both race orders`, async () => {
        const store = await backend.fresh();
        const sibling = await backend.sibling();
        const k = await store.keys.create(key("k"));
        const sql = new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string });
        const conn = await sql.reserve();
        const write = () => {
          const prompts = { ids: ["team"], inheritGlobal: false };
          return writer === "global"
            ? sibling.config.putSettings({ prompts: ["team"] })
            : writer === "create"
              ? sibling.keys.create({ ...key("new"), prompts })
              : writer === "import"
                ? sibling.keys.importRow({ ...k, id: "new", hash: "new", prompts })
                : sibling.keys.setPrompts("k", prompts);
        };
        try {
          await store.prompts.create(prompt());
          // Delete wins while holding the exact shared management lock.
          await conn.unsafe("BEGIN");
          await conn.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
            "omni:prompt-management",
          ]);
          await conn.unsafe("DELETE FROM prompts WHERE id = 'team'");
          const pending = Promise.allSettled([write()]);
          await waitForPromptWaiters(sql, 1);
          await conn.unsafe("COMMIT");
          expect((await pending)[0]).toMatchObject({
            status: "rejected",
            reason: { kind: "missing" },
          });
          expect(await store.prompts.assignments("team")).toEqual({ global: false, keyIds: [] });

          // Queue assignment before deletion; no timing sleeps or scheduler assumptions.
          await store.prompts.create(prompt());
          await conn.unsafe("BEGIN");
          await conn.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
            "omni:prompt-management",
          ]);
          const assigned = Promise.allSettled([write()]);
          await waitForPromptWaiters(sql, 1);
          const deleted = Promise.allSettled([store.prompts.remove("team")]);
          await waitForPromptWaiters(sql, 2);
          await conn.unsafe("COMMIT");
          expect((await assigned)[0]?.status).toBe("fulfilled");
          expect((await deleted)[0]).toMatchObject({
            status: "rejected",
            reason: { kind: "assigned" },
          });
          expect(await store.prompts.get("team")).not.toBeNull();
        } finally {
          await conn.unsafe("ROLLBACK");
          conn.release();
          await sql.close();
        }
      });
    }
  } else {
    test("detail keeps one SQLite snapshot across a sibling save and prune between SELECTs", async () => {
      const store = await backend.fresh();
      await store.prompts.create(prompt());
      for (let i = 0; i < 99; i++) await store.prompts.saveVersion("team", save);
      const readDb = openDb(store.databasePath);
      const writeDb = openDb(store.databasePath);
      const reader = createPromptRepo(readDb, () => {});
      const writer = createPromptRepo(writeDb, () => {});
      const statement = readDb.query<PromptRow, [string]>("SELECT * FROM prompts WHERE id = ?");
      const get = statement.get.bind(statement);
      let committed: ReturnType<typeof writer.saveVersion> | undefined;
      const boundary = spyOn(statement, "get").mockImplementation((id) => {
        const row = get(id);
        // SQLite repo mutations commit synchronously before their Promise is returned.
        committed = writer.saveVersion("team", { ...save, activate: true });
        return row;
      });
      try {
        const detail = await reader.get("team");
        expect(boundary).toHaveBeenCalledTimes(1);
        expect((await committed)?.version).toBe(101);
        expect((await writer.get("team"))?.activeVersion).toBe(101);
        expect(detail?.activeVersion).toBe(1);
        expect(detail?.versions.some((v) => v.version === detail.activeVersion)).toBe(true);
        expect(detail?.versions[0]?.version).toBe(100);
      } finally {
        boundary.mockRestore();
        readDb.close();
        writeDb.close();
      }
    });

    test("retained forwarders survive snapshot replacement and reopen", async () => {
      const store = await backend.fresh();
      await store.prompts.create(prompt());
      await store.keys.create(key("k"));
      const get = store.prompts.get;
      const saveVersion = store.prompts.saveVersion;
      const setPrompts = store.keys.setPrompts;
      const snapshot = `${store.databasePath}.snapshot`;
      await store.maintenance.snapshotTo(snapshot);
      await saveVersion("team", save);
      store.close();
      const { copyFile, rm } = await import("node:fs/promises");
      await copyFile(snapshot, store.databasePath);
      await rm(snapshot);
      await store.reopen();
      expect((await get("team"))?.versions).toHaveLength(1);
      expect((await saveVersion("team", save)).version).toBe(2);
      await setPrompts("k", { ids: ["team"], inheritGlobal: true });
      expect((await store.keys.get("k"))?.prompts.ids).toEqual(["team"]);
    });

    test("raw SQLite immediate transactions exclude a sibling writer", async () => {
      const store = await backend.fresh();
      await store.prompts.create(prompt());
      const first = new Database(store.databasePath);
      const second = new Database(store.databasePath);
      try {
        first.run("BEGIN IMMEDIATE");
        second.run("PRAGMA busy_timeout = 0");
        expect(() =>
          second.transaction(() => second.run("DELETE FROM prompts")).immediate(),
        ).toThrow();
        expect(() =>
          second.transaction(() => second.run("UPDATE api_keys SET prompts = NULL")).immediate(),
        ).toThrow();
        expect(() =>
          second.transaction(() => second.run("UPDATE prompts SET active_version = 1")).immediate(),
        ).toThrow();
        expect(() =>
          second
            .transaction(() => second.run("DELETE FROM prompt_versions WHERE version = 1"))
            .immediate(),
        ).toThrow();
      } finally {
        first.run("ROLLBACK");
        first.close();
        second.close();
      }
    });
  }
});
