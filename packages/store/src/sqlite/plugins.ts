import type { Database } from "bun:sqlite";
import { describeError } from "@omni/ir";
import {
  assertPluginId,
  PLUGIN_ID,
  PLUGIN_TABLE_PREFIX,
  prefixFor,
  preparePluginSql as prepare,
  toBindings,
} from "../plugins/guard.ts";
import type { PluginMigrateResult, PluginMigration, PluginRepo } from "../types.ts";

/**
 * Placeholder expansion and the core-table guard live in `../plugins/guard.ts`,
 * shared with the Postgres repo. `CORE_TABLES` is re-exported so the drift guard
 * in `test/plugins.test.ts` keeps reading it from beside the migrations it pins.
 */
export { CORE_TABLES } from "../plugins/guard.ts";

const PREFIX = PLUGIN_TABLE_PREFIX;

/** Every object name in the schema, so a migration can be judged by what it left. */
function schemaObjects(db: Database): Set<string> {
  const rows = db.query<{ name: string }, []>("SELECT name FROM sqlite_master").all();
  return new Set(rows.map((row) => row.name));
}

/**
 * Refuses a migration that created anything outside the plugin's own namespace.
 *
 * Checked by comparing the schema before and after rather than by parsing the
 * statement, because parsing DDL to find its target is exactly the job a regex
 * does badly — and this cannot be fooled by quoting, whitespace, a `CREATE` the
 * guard did not anticipate, or several statements in one string.
 *
 * The accident is forgetting the placeholder: `CREATE TABLE notes (…)` instead
 * of `CREATE TABLE {{notes}} (…)`. Before this, that succeeded, put `notes` in
 * core's schema, and then vanished — `listTables` filters on the plugin prefix
 * so it never appeared, `orphanTables` could not see it, and `remove --purge`
 * could not drop it. It survived forever, and the failure it eventually produced
 * was a core migration colliding with a squatted name at boot, which reads as a
 * bug in core.
 *
 * Throwing here rolls the migration back, since it runs inside that migration's
 * own transaction — so the refusal leaves no half-made schema behind.
 *
 * `sqlite_`-prefixed names are SQLite's own: `sqlite_autoindex_*` appears
 * whenever a table declares a `PRIMARY KEY` or `UNIQUE`, and is not the plugin's
 * doing.
 */
function assertOwnNamespace(db: Database, pluginId: string, before: Set<string>): void {
  const prefix = `${PREFIX}${pluginId}_`;
  for (const name of schemaObjects(db)) {
    if (before.has(name) || name.startsWith(prefix) || name.startsWith("sqlite_")) continue;
    throw new Error(
      `plugin migration created ${name}, which is outside this plugin's namespace — ` +
        `name it {{…}} so it becomes ${prefix}…`,
    );
  }
}

/**
 * The plugin storage repository: one namespace per plugin inside core's file.
 *
 * Everything here is synchronous, like the rest of `bun:sqlite`, and none of it
 * belongs on a request path. See `PluginRepo` in `../types.ts` for why the
 * namespacing is a placeholder expansion rather than a naming convention the
 * plugin is asked to honour.
 */
export function createPluginRepo(db: Database): PluginRepo {
  /**
   * Table names starting with `plugin_`, sorted, excluding core's own ledger.
   *
   * `plugin_migrations` is a core table whose name starts with the plugin
   * prefix, so every sweep over `plugin_*` has to exclude it explicitly. It is
   * on the denylist as well; this is the second half of the same trap, and the
   * half that would otherwise let `orphanTables` report core's ledger as an
   * orphan and an operator drop it.
   */
  const pluginTables = (): string[] =>
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((r) => r.name)
      .filter((name) => name.startsWith(PREFIX) && name !== "plugin_migrations");

  /**
   * This plugin's tables. Filtered in JavaScript rather than by
   * `LIKE 'plugin_x_%'`, because `_` is a single-character wildcard in `LIKE`:
   * that pattern also matches `pluginAxB…`, and the `ESCAPE` clause that fixes
   * it is one more thing to remember at every call site. `startsWith` has no
   * such subtlety.
   */
  const tablesOf = (pluginId: string): string[] => {
    const prefix = prefixFor(pluginId);
    return pluginTables().filter((name) => name.startsWith(prefix));
  };

  const appliedVersions = (pluginId: string): Set<number> =>
    new Set(
      db
        .query<{ version: number }, [string]>(
          "SELECT version FROM plugin_migrations WHERE plugin_id = ?",
        )
        .all(pluginId)
        .map((r) => r.version),
    );

  return {
    async migrate(
      pluginId: string,
      migrations: readonly PluginMigration[],
    ): Promise<PluginMigrateResult> {
      assertPluginId(pluginId);
      const done = appliedVersions(pluginId);
      const applied: number[] = [];

      // Sorted on a copy: the caller's array is the plugin's own export and
      // reordering it under them would be a side effect on a value they own.
      const ordered = [...migrations].sort((a, b) => a.version - b.version);

      for (const migration of ordered) {
        if (done.has(migration.version)) continue;
        try {
          if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
            throw new Error("migration version must be a positive integer");
          }
          const sql = prepare(pluginId, migration.sql);
          // One transaction per migration, closed before the next one opens.
          // The recording insert is inside it, so "the schema changed" and "we
          // know the schema changed" commit together or not at all — a crash
          // between the two would otherwise re-run a migration that already ran.
          const before = schemaObjects(db);
          db.transaction(() => {
            db.run(sql);
            // Inside the transaction, so a migration that squatted a name
            // outside its namespace is rolled back rather than reported after
            // the fact. The check is the schema itself, not the statement.
            assertOwnNamespace(db, pluginId, before);
            db.run(
              "INSERT INTO plugin_migrations (plugin_id, version, applied_at) VALUES (?,?,?)",
              [pluginId, migration.version, Date.now()],
            );
          })();
          applied.push(migration.version);
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

    async run(pluginId: string, sql: string, params?: unknown[]): Promise<void> {
      db.run(prepare(pluginId, sql), toBindings(params));
    },

    async all<T>(pluginId: string, sql: string, params?: unknown[]): Promise<T[]> {
      return db.prepare(prepare(pluginId, sql)).all(...toBindings(params)) as T[];
    },

    async get<T>(pluginId: string, sql: string, params?: unknown[]): Promise<T | null> {
      const row = db.prepare(prepare(pluginId, sql)).get(...toBindings(params));
      return row === null || row === undefined ? null : (row as T);
    },

    async transaction<T>(pluginId: string, fn: () => Promise<T>): Promise<T> {
      assertPluginId(pluginId);
      // Hand-rolled rather than `db.transaction`, which takes a synchronous
      // function. See `PluginRepo.transaction` for what this is and is not.
      db.run("BEGIN");
      try {
        const out = await fn();
        db.run("COMMIT");
        return out;
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }
    },

    async listTables(pluginId: string): Promise<string[]> {
      assertPluginId(pluginId);
      return tablesOf(pluginId);
    },

    async dropAll(pluginId: string): Promise<number> {
      assertPluginId(pluginId);
      const tables = tablesOf(pluginId);
      db.transaction(() => {
        // Quoted for the same reason expansion quotes: a hyphenated plugin id
        // makes a bare identifier a syntax error. Indexes and triggers on these
        // tables go with them; SQLite drops them as part of `DROP TABLE`.
        for (const table of tables) db.run(`DROP TABLE IF EXISTS "${table}"`);
        // The ledger rows go too, so a reinstall replays the plugin's migrations
        // against the empty schema it now actually has. Leaving them would mean
        // a purged plugin comes back with its migrations "already applied" and
        // no tables — the one state neither the plugin nor the host can repair.
        db.run("DELETE FROM plugin_migrations WHERE plugin_id = ?", [pluginId]);
      })();
      return tables.length;
    },

    async orphanTables(installedIds: readonly string[]): Promise<string[]> {
      // Matched by prefix per installed id rather than by parsing an id back out
      // of the table name. `plugin_<id>_<name>` is not decodable: `<name>` may
      // contain `_`, so `plugin_a_b_c` splits three ways and a wrong split
      // reports a live plugin's table as an orphan. Asking each installed id
      // "is this yours?" needs no split and cannot guess.
      //
      // An id that fails the pattern is dropped rather than thrown on: it could
      // never have created a table — every write path asserts it first — so
      // whatever it claims to own does not exist, and refusing to produce the
      // report would deny an operator the one view that shows the problem.
      const prefixes = installedIds.filter((id) => PLUGIN_ID.test(id)).map(prefixFor);
      return pluginTables().filter((name) => !prefixes.some((p) => name.startsWith(p)));
    },
  };
}
