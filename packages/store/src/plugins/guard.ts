/**
 * The pure half of plugin storage: placeholder expansion and the core-table
 * guard, shared by the SQLite and Postgres repos so the two cannot drift. A
 * plugin refused a statement at install on one backend must be refused the
 * same statement on the other.
 */

/**
 * The manifest's own id pattern, restated here rather than imported.
 *
 * The host validates it at load; this repo validates it again because the id
 * becomes a SQL identifier the moment it is used, and a validation that lives
 * only in the caller is one a future caller forgets. Hyphens are legal — an id
 * is a URL path segment too — which is why expansion quotes the identifier
 * instead of splicing it in bare.
 */
export const PLUGIN_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The `<name>` half of a placeholder, per the spec: `^[a-z][a-z0-9_]{0,31}$`.
 *
 * Deliberately narrower than what either database accepts. It excludes quotes,
 * brackets, backticks, whitespace, and dots, so an expanded name cannot
 * terminate the quoted identifier it is spliced into and cannot carry a schema
 * qualifier. There is no legitimate table name this rejects.
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
 * Every table core owns, as created by SQLite migrations 001 through 012.
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
 * than derived" is only safe while something enforces the enumeration: a
 * migration adding a table nobody adds here would otherwise open a silent hole
 * in the denylist, which is the one failure mode a guardrail may not have.
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
 * Tables only the Postgres schema holds. Kept apart from `CORE_TABLES` because
 * that list is pinned against a migrated SQLite file; the Postgres contract
 * suite pins the union against a migrated Postgres schema the same way.
 */
export const POSTGRES_CORE_TABLES = ["config_version"] as const;

/**
 * A core name appearing as a whole word anywhere in the statement.
 *
 * Word boundaries do the work that would otherwise need a parser. They catch
 * every way an identifier can be written — `request_logs`, `"request_logs"`,
 * `[request_logs]`, backticked — because none of the quoting characters is a
 * word character. They also do *not* fire on this repo's own expansions:
 * `plugin_pokemon_settings` has a `_` before `settings`, `_` is a word
 * character, so there is no boundary there to match.
 *
 * **Case-insensitive, and that flag is load-bearing rather than tidy.** Both
 * databases match unquoted identifiers without regard to case, so `DELETE FROM
 * API_KEYS` reaches exactly the table `api_keys` names. Without the flag this
 * guard refused the lowercase spelling and let the uppercase one through to
 * core data — which is not an exotic attack but the ordinary habit of writing
 * SQL in capitals. Nothing else here needs to change: plugin table names are
 * matched against `^[a-z][a-z0-9_]{0,31}$` before expansion, so there is no
 * lowercase-only assumption downstream for this to disturb.
 */
const CORE_TABLE_REFERENCE = new RegExp(
  `\\b(?:${[...CORE_TABLES, ...POSTGRES_CORE_TABLES].join("|")})\\b`,
  "i",
);

/** What may be handed to either driver as a bound parameter. */
export type Binding = string | number | bigint | boolean | null | Uint8Array;

export const PLUGIN_TABLE_PREFIX = "plugin_";

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
  return `"${PLUGIN_TABLE_PREFIX}${pluginId}_${name}"`;
}

/** The prefix every table of one plugin shares, unquoted, as the catalog stores it. */
export function prefixFor(pluginId: string): string {
  return `${PLUGIN_TABLE_PREFIX}${pluginId}_`;
}

export function assertPluginId(pluginId: string): void {
  if (!PLUGIN_ID.test(pluginId)) {
    throw new Error(`plugin id ${JSON.stringify(pluginId)} is not a valid identifier`);
  }
}

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
 * count falls while the file keeps every page. On Postgres the same list holds
 * `SET`/`RESET`: a pooled connection outlives the plugin's call, and a changed
 * `search_path` would follow it to whoever draws that connection next.
 *
 * Matched at the start of the statement only. A column called `pragma` or a
 * plugin storing the word is doing nothing wrong, and this guard exists to stop
 * an accident, not to hunt for the string.
 */
const CONNECTION_STATEMENT = /^\s*(pragma|attach|detach|vacuum|set|reset)\b/i;

/**
 * Expands placeholders and refuses the result if it names a core table.
 *
 * The same function serves migrations and runtime queries. Two of these would
 * drift, and the drift would be discovered by a plugin doing at runtime what it
 * was refused at install — so there is one, called from every entry point.
 */
export function preparePluginSql(pluginId: string, sql: string): string {
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

/**
 * Narrows one caller-supplied parameter to something a driver can bind.
 *
 * The interface takes `unknown[]` because a plugin's values arrive from a plugin
 * and this package will not pretend to know their type. Narrowing at the
 * boundary means an object or a `Date` fails here, naming the index, rather than
 * inside the driver as a message about a different layer.
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

export const toBindings = (params: unknown[] | undefined): Binding[] =>
  (params ?? []).map(toBinding);
