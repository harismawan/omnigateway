import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { DEFAULT_SETTINGS, type Settings } from "../../src/types.ts";
import { exec, forEachStore } from "./harness.ts";

forEachStore((backend) => {
  test("legacy upgrade; present empty or malformed prompts is authoritative", async () => {
    const store = await backend.fresh();
    for (const value of [
      { ponytailMode: "full" },
      { prompts: [], ponytailMode: "full" },
      { prompts: null, ponytailMode: "full" },
      { prompts: ["ponytail-lite", "ponytail-full"], ponytailMode: "ultra" },
    ]) {
      const raw = JSON.stringify(value);
      await exec(
        backend,
        store,
        `INSERT INTO settings (key,value) VALUES ('settings','${raw}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      );
      const expected =
        "prompts" in value
          ? Array.isArray(value.prompts)
            ? value.prompts.slice(0, 1)
            : []
          : ["ponytail-full"];
      expect(await store.config.getSettings()).toMatchObject({
        prompts: expected,
        ponytailMode: expected[0]?.slice(9) ?? "off",
      });
      const sql =
        backend.name === "postgres"
          ? new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string })
          : null;
      const db = sql ? null : new Database(store.databasePath);
      try {
        const row = sql
          ? (
              await sql.unsafe<{ value: string }[]>(
                "SELECT value FROM settings WHERE key = 'settings'",
              )
            )[0]
          : db
              ?.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'settings'")
              .get();
        expect(row?.value).toBe(raw);
      } finally {
        await sql?.close();
        db?.close();
      }
    }
    expect((await store.config.putSettings({ maxAttempts: 4 })).prompts).toEqual(["ponytail-lite"]);
  });

  const cases: Array<{
    label: string;
    patch: Partial<Settings>;
    ids: string[];
    mode: Settings["ponytailMode"];
  }> = [
    {
      label: "only list changed",
      patch: { prompts: ["ponytail-ultra", "team"], ponytailMode: "lite" },
      ids: ["ponytail-ultra", "team"],
      mode: "ultra",
    },
    {
      label: "only mode changed replaces in place",
      patch: { prompts: ["team", "ponytail-lite", "other"], ponytailMode: "full" },
      ids: ["team", "ponytail-full", "other"],
      mode: "full",
    },
    {
      label: "both changed list wins",
      patch: { prompts: ["other"], ponytailMode: "full" },
      ids: ["other"],
      mode: "off",
    },
    {
      label: "neither changed",
      patch: { prompts: ["team", "ponytail-lite", "other"], ponytailMode: "lite" },
      ids: ["team", "ponytail-lite", "other"],
      mode: "lite",
    },
    {
      label: "off removes builtin",
      patch: { ponytailMode: "off" },
      ids: ["team", "other"],
      mode: "off",
    },
    {
      label: "omitted list preserves users",
      patch: { ponytailMode: "full" },
      ids: ["team", "ponytail-full", "other"],
      mode: "full",
    },
  ];
  for (const row of cases) {
    test(`alias truth table: ${row.label}`, async () => {
      const store = await backend.fresh();
      for (const id of ["team", "other"])
        await store.prompts.create({
          id,
          name: id,
          description: null,
          text: id,
          note: null,
          activate: true,
        });
      await store.config.putSettings({ prompts: ["team", "ponytail-lite", "other"] });
      const saved = await store.config.putSettings(row.patch);
      expect(saved.prompts).toEqual(row.ids);
      expect(saved.ponytailMode).toBe(row.mode);
      expect(await store.config.getSettings()).toEqual(saved);
    });
  }

  test("mode appends when no builtin exists and empty-list writes mirror off", async () => {
    const store = await backend.fresh();
    expect((await store.config.putSettings({ ponytailMode: "full" })).prompts).toEqual([
      "ponytail-full",
    ]);
    expect(await store.config.putSettings({ prompts: [] })).toMatchObject({
      prompts: [],
      ponytailMode: "off",
    });
  });

  for (const existing of [false, true]) {
    test(`concurrent ${existing ? "existing-row" : "first"} writes retain aliases and retention`, async () => {
      const store = await backend.fresh();
      const sibling = await backend.sibling();
      if (existing) await store.config.putSettings({ maxAttempts: 7 });
      await Promise.all([
        store.config.putSettings({ ponytailMode: "full", logRetentionDays: 7 }),
        sibling.config.putSettings({ bodyRetentionDays: 9 }),
      ]);
      const saved = await store.config.getSettings();
      expect(saved).toMatchObject({
        prompts: ["ponytail-full"],
        ponytailMode: "full",
        logRetentionDays: 7,
        bodyRetentionDays: 9,
        maxAttempts: existing ? 7 : DEFAULT_SETTINGS.maxAttempts,
      });
      expect(saved.logRetentionLoweredAt).toBeGreaterThan(0);
      const stale = { ...saved, ponytailMode: "ultra" as const, logRetentionLoweredAt: 0 };
      await sibling.config.putSettings({ prompts: ["ponytail-lite"] });
      expect(await store.config.putSettings(stale)).toMatchObject({
        prompts: ["ponytail-full"],
        ponytailMode: "full",
        logRetentionLoweredAt: saved.logRetentionLoweredAt,
      });
    });
  }

  if (backend.name === "postgres") {
    test("a queued whole-object write compares aliases after acquiring the management lock", async () => {
      const store = await backend.fresh();
      const stale = await store.config.putSettings({ prompts: ["ponytail-lite"] });
      const sql = new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string });
      const conn = await sql.reserve();
      try {
        await conn.unsafe("BEGIN");
        await conn.unsafe("SELECT pg_advisory_xact_lock(hashtext('omni:prompt-management'))");
        // An uncommitted newer row is invisible to any premature settings read.
        const latest = {
          ...stale,
          prompts: ["ponytail-full"],
          ponytailMode: "full",
          bodyRetentionDays: 9,
        };
        await conn.unsafe("UPDATE settings SET value = $1 WHERE key = 'settings'", [
          JSON.stringify(latest),
        ]);
        const pending = store.config.putSettings({
          prompts: stale.prompts,
          ponytailMode: "lite",
          logRetentionDays: 7,
        });
        let waiting = false;
        for (let i = 0; i < 1000; i++) {
          const rows = await sql.unsafe<{ n: string }[]>(
            "SELECT COUNT(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = (hashtext('omni:prompt-management')::bigint & 4294967295)::oid",
          );
          if (Number(rows[0]?.n) > 0) {
            waiting = true;
            break;
          }
        }
        expect(waiting).toBe(true);
        await conn.unsafe("COMMIT");
        const saved = await pending;
        expect(saved).toMatchObject({
          prompts: ["ponytail-lite"],
          ponytailMode: "lite",
          bodyRetentionDays: 9,
          logRetentionDays: 7,
        });
        expect(saved.logRetentionLoweredAt).toBeGreaterThan(0);
      } finally {
        await conn.unsafe("ROLLBACK");
        conn.release();
        await sql.close();
      }
    });
  }
});
