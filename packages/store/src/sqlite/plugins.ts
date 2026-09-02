import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describeError } from "@omni/ir";
import type { PluginMigrateResult, PluginMigration, PluginRepo } from "../types.ts";

/**
 * The manifest's own id pattern, restated here rather than imported.
 *
 * The host validates it at load; this repo validates it again because the id
 * becomes a SQL identifier the moment it is used, and a validation that lives
 * only in the caller is one a future caller forgets. Hyphens are legal — an id
 * is a URL path segment too — which is why expansion quotes the identifier
 * instead of splicing it in bare.
 */
const PLUGIN_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The `<name>` half of a placeholder, per the spec: `^[a-z][a-z0-9_]{0,31}$`.
 *
 * Deliberately narrower than what SQLite accepts. It excludes quotes, brackets,
 * backticks, whitespace, and dots, so an expanded name cannot terminate the
 * quoted identifier it is spliced into and cannot carry a schema qualifier.
 * There is no legitimate table name this rejects.
 */
const TABLE_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * `{{name}}`, matched without trimming.
 *
 * `{{ caught }}` is rejected rather than accepted-and-trimmed. Leniency here
 * would mean two spellings of one table and a plugin author who never learns
 * which one the host actually used; a hard error at install names the line.
 */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/**
 * Every table core owns, as created by migrations 001 through 011.
 *
 * Enumerated from the migration files rather than derived, so adding a core
 * table is a decision to add it here too. Note `settings`: `ConfigRepo` is the
 * repo's name, the table's name is `settings`, and it is the table name that has
 * to be on this list.
 *
 * This list is a **guardrail, not a sandbox**. A plugin is `import`ed into the
 * gateway process, which holds `OMNI_ENCRYPTION_KEY`, decrypted provider tokens,
 * and API-key hashes; it can import `@omni/store` and read any of them without
 * going near this repo. What the list catches is the accident — a migration
 * pasted from a query someone ran against `request_logs`, a `DELETE` whose
 * `FROM` was never edited to the plugin's own table. It stops honest mistakes
 * and makes no claim beyond that.
 *
 * Exported for the drift guard in `test/plugins.test.ts`, which opens a freshly
 * migrated database and asserts this list *is* its table set. "Enumerated rather
 * than derived" is only safe while something enforces the enumeration: migration
 * 012 adding a table nobody adds here would otherwise open a silent hole in the
 * denylist, which is the one failure mode a guardrail may not have.
 */
export const CORE_TABLES = [
  "api_keys",
  "credential_health",
  "credentials",
  "migrations",
  "nodes",
  "plugin_migrations",
  "quota_samples",
  "quota_windows",
  "request_bodies",
  "request_logs",
  "settings",
  "usage_daily",
  "usage_rollup",
  "virtual_models",
] as const;

/**
 * A core name appearing as a whole word anywhere in the statement.
 *
 * Word boundaries do the work that would otherwise need a parser. They catch
 * every way SQLite lets an identifier be written — `request_logs`,
 * `"request_logs"`, `[request_logs]`, backticked — because none of the quoting
 * characters is a word character. They also do *not* fire on this repo's own
 * expansions: `plugin_pokemon_settings` has a `_` before `settings`, `_` is a
 * word character, so there is no boundary there to match.
 *
 * **Case-insensitive, and that flag is load-bearing rather than tidy.** SQLite
 * matches identifiers without regard to case, so `DELETE FROM API_KEYS` reaches
 * exactly the table `api_keys` names. Without the flag this guard refused the
 * lowercase spelling and let the uppercase one through to core data — which is
 * not an exotic attack but the ordinary habit of writing SQL in capitals.
 * Nothing else here needs to change: plugin table names are matched against
 * `^[a-z][a-z0-9_]{0,31}$` before expansion, so there is no lowercase-only
 * assumption downstream for this to disturb.
 */
const CORE_TABLE_REFERENCE = new RegExp(`\\b(?:${CORE_TABLES.join("|")})\\b`, "i");

/** What may be handed to SQLite as a bound parameter. */
type Binding = string | number | bigint | boolean | null | Uint8Array;

const PREFIX = "plugin_";

/**
 * Removes string literals and comments before the denylist reads the statement.
 *
 * Written as a scanner rather than three chained `replace` calls because the
 * chained version gets the interaction wrong in both orders: strip comments
 * first and a `--` inside a literal truncates the statement; strip literals
 * first and an apostrophe inside a comment swallows everything to the next
 * quote. One left-to-right pass has no ordering to get wrong.
 *
 * The point is false positives, not evasion. A plugin storing the literal text
 * `'api_keys'` in a row is doing nothing wrong and must not be refused for it —
 * and a plugin that wants to reach `api_keys` for real has `import` and does not
 * need to smuggle the name past a regex.
 */
function stripNoise(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '"' || c === "`" || c === "[") {
      // A quoted identifier, copied through rather than erased: it may *be* a
      // core name, and that is exactly what the denylist is looking for.
      //
      // It has to be recognised at all because an apostrophe inside one would
      // otherwise open a phantom string literal and erase everything to the next
      // quote — `WITH "a'b" AS (SELECT 1) DELETE FROM api_keys` reached
      // `api_keys` with the guard reading an empty statement. Nobody types that
      // by accident, so this is not the hole that mattered; the comment above
      // claiming every quoting form was handled is what mattered, and it is now
      // true rather than aspirational.
      const close = c === "[" ? "]" : c;
      out += c;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === close) {
          // `""` and ``` `` ``` are escaped quotes inside the identifier. `]` has
          // no escape form in SQLite, so it always closes.
          if (close !== "]" && sql[i + 1] === close) {
            out += close + close;
            i += 2;
            continue;
          }
          break;
        }
        out += sql[i];
        i += 1;
      }
      out += close;
      i += 1;
    } else if (c === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          // `''` is an escaped quote inside the literal, not its end.
          if (sql[i + 1] === "'") i += 2;
          else break;
        } else i += 1;
      }
      i += 1;
      out += " ";
    } else if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += " ";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * The real table name behind `{{name}}` for one plugin.
 *
 * Quoted, because a plugin id may contain hyphens and `plugin_poke-dex_caught`
 * is a syntax error unquoted. Quoting is also why both halves are validated
 * against patterns that exclude `"`: an unvalidated name could close the quote
 * and continue the statement, which is the one thing expansion must not permit.
 */
function tableFor(pluginId: string, name: string): string {
  return `"${PREFIX}${pluginId}_${name}"`;
}

/** The prefix every table of one plugin shares, unquoted, as SQLite stores it. */
function prefixFor(pluginId: string): string {
  return `${PREFIX}${pluginId}_`;
}

function assertPluginId(pluginId: string): void {
  if (!PLUGIN_ID.test(pluginId)) {
    throw new Error(`plugin id ${JSON.stringify(pluginId)} is not a valid identifier`);
  }
}

/**
 * Expands placeholders and refuses the result if it names a core table.
 *
 * The same function serves migrations and runtime queries. Two of these would
 * drift, and the drift would be discovered by a plugin doing at runtime what it
 * was refused at install — so there is one, called from every entry point.
 */
/**
 * Statements that reconfigure the connection rather than touch a table.
 *
 * The gateway's database handle is shared, so these do not act on the plugin —
 * they act on everyone. `PRAGMA journal_mode = WAL;` opens half the SQLite
 * migration guides on the internet, and pasting it here takes the *whole
 * gateway* out of WAL; `PRAGMA foreign_keys=OFF` disables enforcement for core's
 * own writes; `ATTACH` bolts another file onto the connection and hands it a
 * name the placeholder rules never see. `VACUUM` is refused for the reason
 * recorded in `CLAUDE.md`: core's own `vacuum()` must checkpoint first or page
 * count falls while the file keeps every page.
 *
 * Matched at the start of the statement only. A column called `pragma` or a
 * plugin storing the word is doing nothing wrong, and this guard exists to stop
 * an accident, not to hunt for the string.
 */
const CONNECTION_STATEMENT = /^\s*(pragma|attach|detach|vacuum)\b/i;

function prepare(pluginId: string, sql: string): string {
  assertPluginId(pluginId);
  const expanded = sql.replace(PLACEHOLDER, (_match, name: string) => {
    if (!TABLE_NAME.test(name)) {
      throw new Error(
        `plugin table placeholder ${JSON.stringify(name)} must match ${TABLE_NAME.source}`,
      );
    }
    return tableFor(pluginId, name);
  });

  const stripped = stripNoise(expanded);

  const connection = CONNECTION_STATEMENT.exec(stripped);
  if (connection !== null) {
    throw new Error(
      `plugin sql may not ${connection[1]?.toUpperCase()}: the database handle is the gateway's, ` +
        "and this would reconfigure it for everything sharing it",
    );
  }

  const found = CORE_TABLE_REFERENCE.exec(stripped);
  if (found !== null) {
    throw new Error(`plugin sql may not reference the core table ${found[0]}`);
  }
  return expanded;
}

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
 * Narrows one caller-supplied parameter to something SQLite can bind.
 *
 * The interface takes `unknown[]` because a plugin's values arrive from a plugin
 * and this package will not pretend to know their type. Narrowing at the
 * boundary means an object or a `Date` fails here, naming the index, rather than
 * inside `bun:sqlite` as a message about a different layer.
 */
function toBinding(value: unknown, index: number): Binding {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new Error(`plugin sql parameter ${index} is not a bindable value`);
}

const toBindings = (params: unknown[] | undefined): SQLQueryBindings[] =>
  (params ?? []).map(toBinding);

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
    migrate(pluginId: string, migrations: readonly PluginMigration[]): PluginMigrateResult {
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

    run(pluginId: string, sql: string, params?: unknown[]): void {
      db.run(prepare(pluginId, sql), toBindings(params));
    },

    all<T>(pluginId: string, sql: string, params?: unknown[]): T[] {
      return db.prepare(prepare(pluginId, sql)).all(...toBindings(params)) as T[];
    },

    get<T>(pluginId: string, sql: string, params?: unknown[]): T | null {
      const row = db.prepare(prepare(pluginId, sql)).get(...toBindings(params));
      return row === null || row === undefined ? null : (row as T);
    },

    transaction<T>(pluginId: string, fn: () => T): T {
      assertPluginId(pluginId);
      return db.transaction(fn)();
    },

    listTables(pluginId: string): string[] {
      assertPluginId(pluginId);
      return tablesOf(pluginId);
    },

    dropAll(pluginId: string): number {
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

    orphanTables(installedIds: readonly string[]): string[] {
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
