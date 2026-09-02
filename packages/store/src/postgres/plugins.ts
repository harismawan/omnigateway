import { AsyncLocalStorage } from "node:async_hooks";
import { describeError } from "@omni/ir";
import type { SQL } from "bun";
import {
  assertPluginId,
  PLUGIN_ID,
  PLUGIN_TABLE_PREFIX,
  prefixFor,
  preparePluginSql,
  toBindings,
} from "../plugins/guard.ts";
import type { PluginMigrateResult, PluginMigration, PluginRepo } from "../types.ts";
import { type Conn, MIGRATION_LOCK, type Rows } from "./db.ts";

const prepare = preparePluginSql;

/**
 * Every relation name in the current schema, so a migration can be judged by
 * what it left. Tables, indexes, sequences and views alike: an identity
 * column's sequence and a primary key's index are named after their table, so
 * a plugin's land inside its prefix and a squatted one does not.
 */
async function schemaObjects(conn: Conn): Promise<Set<string>> {
  const rows = await conn.unsafe<Rows<{ relname: string }>>(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()`,
  );
  return new Set(rows.map((row) => row.relname));
}

/**
 * Refuses a migration that created anything outside the plugin's own namespace.
 *
 * Checked by comparing the schema before and after rather than by parsing the
 * statement, because parsing DDL to find its target is exactly the job a regex
 * does badly. The accident is forgetting the placeholder: `CREATE TABLE notes`
 * instead of `CREATE TABLE {{notes}}`, which would put `notes` in core's schema
 * where `listTables`, `orphanTables` and `remove --purge` could never see it.
 *
 * Throwing here rolls the migration back, since it runs inside that migration's
 * own transaction and Postgres DDL is transactional — so the refusal leaves no
 * half-made schema behind.
 */
async function assertOwnNamespace(
  conn: Conn,
  pluginId: string,
  before: Set<string>,
): Promise<void> {
  const prefix = prefixFor(pluginId);
  for (const name of await schemaObjects(conn)) {
    if (before.has(name) || name.startsWith(prefix)) continue;
    throw new Error(
      `plugin migration created ${name}, which is outside this plugin's namespace — ` +
        `name it {{…}} so it becomes ${prefix}…`,
    );
  }
}

/**
 * The plugin storage repository: one namespace per plugin inside core's schema.
 *
 * Placeholder expansion and the core-table guard are `../plugins/guard.ts`,
 * shared with SQLite, so a statement refused there is refused here. What is
 * Postgres's own is the transaction: `transaction(fn)` reserves a connection
 * and every `run`/`all`/`get` made while `fn` runs is routed onto it through
 * `AsyncLocalStorage`, so the plugin's writes commit or roll back together
 * without the plugin holding the connection.
 */
export function createPluginRepo(sql: SQL): PluginRepo {
  const active = new AsyncLocalStorage<Conn>();
  /** The transaction's connection while one is open on this async path, else the pool. */
  const conn = (): Conn => active.getStore() ?? sql;

  /**
   * Table names starting with `plugin_`, sorted, excluding core's own ledger.
   *
   * `plugin_migrations` is a core table whose name starts with the plugin
   * prefix, so every sweep over `plugin_*` has to exclude it explicitly. It is
   * on the denylist as well; this is the second half of the same trap, and the
   * half that would otherwise let `orphanTables` report core's ledger as an
   * orphan and an operator drop it.
   */
  const pluginTables = async (): Promise<string[]> =>
    (
      await sql.unsafe<Rows<{ table_name: string }>>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
          ORDER BY table_name COLLATE "C"`,
      )
    )
      .map((r) => r.table_name)
      .filter((name) => name.startsWith(PLUGIN_TABLE_PREFIX) && name !== "plugin_migrations");

  /**
   * This plugin's tables. Filtered in JavaScript rather than by
   * `LIKE 'plugin_x_%'`, because `_` is a single-character wildcard in `LIKE`:
   * that pattern also matches `pluginAxB…`. `startsWith` has no such subtlety.
   */
  const tablesOf = async (pluginId: string): Promise<string[]> => {
    const prefix = prefixFor(pluginId);
    return (await pluginTables()).filter((name) => name.startsWith(prefix));
  };

  return {
    async migrate(
      pluginId: string,
      migrations: readonly PluginMigration[],
    ): Promise<PluginMigrateResult> {
      assertPluginId(pluginId);
      const applied: number[] = [];

      // Sorted on a copy: the caller's array is the plugin's own export and
      // reordering it under them would be a side effect on a value they own.
      const ordered = [...migrations].sort((a, b) => a.version - b.version);

      for (const migration of ordered) {
        try {
          if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
            throw new Error("migration version must be a positive integer");
          }
          const sql1 = prepare(pluginId, migration.sql);
          // One transaction per migration, closed before the next one opens.
          // The recording insert is inside it, so "the schema changed" and "we
          // know the schema changed" commit together or not at all.
          //
          // The applied check is *inside* the transaction and *after* the
          // lock, not read once up front as the SQLite repo does: two replicas
          // booting together both hold this plugin, and the one that queues
          // behind the other's walk must see its rows rather than re-run them.
          const done = await sql.begin(async (tx): Promise<boolean> => {
            await tx.unsafe(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`);
            const seen = await tx.unsafe(
              "SELECT 1 FROM plugin_migrations WHERE plugin_id = $1 AND version = $2",
              [pluginId, migration.version],
            );
            if (seen.length > 0) return false;
            const before = await schemaObjects(tx);
            await tx.unsafe(sql1);
            // Inside the transaction, so a migration that squatted a name
            // outside its namespace is rolled back rather than reported after
            // the fact. The check is the schema itself, not the statement.
            await assertOwnNamespace(tx, pluginId, before);
            await tx.unsafe(
              "INSERT INTO plugin_migrations (plugin_id, version, applied_at) VALUES ($1,$2,$3)",
              [pluginId, migration.version, Date.now()],
            );
            return true;
          });
          if (done) applied.push(migration.version);
        } catch (error) {
          // Stop here and report. Everything already in `applied` stays applied:
          // it committed, and rolling it back would mean re-applying it on the
          // next boot only to fail at this same version again.
          return {
            applied,
            failed: {
              version: migration.version,
              reason: describeError(error, String(error)),
            },
          };
        }
      }
      return { applied };
    },

    async run(pluginId: string, sql1: string, params?: unknown[]): Promise<void> {
      await conn().unsafe(prepare(pluginId, sql1), toBindings(params));
    },

    async all<T>(pluginId: string, sql1: string, params?: unknown[]): Promise<T[]> {
      const rows = await conn().unsafe<Rows<T>>(prepare(pluginId, sql1), toBindings(params));
      return [...rows];
    },

    async get<T>(pluginId: string, sql1: string, params?: unknown[]): Promise<T | null> {
      const rows = await conn().unsafe<Rows<T>>(prepare(pluginId, sql1), toBindings(params));
      return rows[0] ?? null;
    },

    async transaction<T>(pluginId: string, fn: () => Promise<T>): Promise<T> {
      assertPluginId(pluginId);
      // A real transaction on a connection of its own: `fn`'s storage calls
      // land on it through `active`, and any other write the gateway makes
      // meanwhile goes to the pool and is untouched by a rollback here.
      return sql.begin((tx) => active.run(tx, fn)) as Promise<T>;
    },

    async listTables(pluginId: string): Promise<string[]> {
      assertPluginId(pluginId);
      return tablesOf(pluginId);
    },

    async dropAll(pluginId: string): Promise<number> {
      assertPluginId(pluginId);
      const tables = await tablesOf(pluginId);
      await sql.begin(async (tx) => {
        // Quoted for the same reason expansion quotes: a hyphenated plugin id
        // makes a bare identifier a syntax error. Indexes and triggers on these
        // tables go with them.
        for (const table of tables) await tx.unsafe(`DROP TABLE IF EXISTS "${table}"`);
        // The ledger rows go too, so a reinstall replays the plugin's migrations
        // against the empty schema it now actually has.
        await tx.unsafe("DELETE FROM plugin_migrations WHERE plugin_id = $1", [pluginId]);
      });
      return tables.length;
    },

    async orphanTables(installedIds: readonly string[]): Promise<string[]> {
      // Matched by prefix per installed id rather than by parsing an id back out
      // of the table name: `plugin_<id>_<name>` is not decodable, since `<name>`
      // may contain `_`. An id that fails the pattern is dropped rather than
      // thrown on: it could never have created a table.
      const prefixes = installedIds.filter((id) => PLUGIN_ID.test(id)).map(prefixFor);
      return (await pluginTables()).filter((name) => !prefixes.some((p) => name.startsWith(p)));
    },
  };
}
