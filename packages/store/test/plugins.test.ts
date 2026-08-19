import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/sqlite/db.ts";
import { CORE_TABLES, createPluginRepo } from "../src/sqlite/plugins.ts";
import type { PluginMigration, PluginRepo } from "../src/types.ts";

/**
 * A database on disk in a temp directory rather than `:memory:`.
 *
 * Nothing here needs a file, but `openDb` is the only way to get the migrated
 * schema — `plugin_migrations` included — and running it against a real path is
 * what the gateway does. Every root is registered for teardown so a failing
 * assertion cannot leave one behind.
 */
const roots: string[] = [];

function tempDb(): Database {
  const root = mkdtempSync(join(tmpdir(), "omni-plugins-"));
  roots.push(root);
  return openDb(join(root, "omnigateway.db"));
}

function repo(): { db: Database; plugins: PluginRepo } {
  const db = tempDb();
  return { db, plugins: createPluginRepo(db) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The migration a well-behaved plugin ships: placeholders, no table names. */
const CREATE_CAUGHT: PluginMigration = {
  version: 1,
  sql: "CREATE TABLE {{caught}} (id INTEGER PRIMARY KEY, species TEXT NOT NULL)",
};

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
}

test("migration 011 creates the plugin ledger with a composite key", () => {
  const db = tempDb();
  expect(tableNames(db)).toContain("plugin_migrations");

  db.run("INSERT INTO plugin_migrations (plugin_id, version, applied_at) VALUES ('a', 1, 1)");
  // The pair is the identity: the same version twice is the thing the table
  // exists to refuse, and it must be refused by the schema, not by a caller.
  expect(() =>
    db.run("INSERT INTO plugin_migrations (plugin_id, version, applied_at) VALUES ('a', 1, 2)"),
  ).toThrow();
  db.run("INSERT INTO plugin_migrations (plugin_id, version, applied_at) VALUES ('b', 1, 3)");
  db.close();
});

test("CORE_TABLES is exactly the table set a freshly migrated database holds", () => {
  // The drift guard. `CORE_TABLES` is enumerated from the migration files rather
  // than derived from the schema, which is the right call — the denylist must not
  // change meaning because a plugin created a table — but it only stays true
  // while something enforces it. Migration 012 adding a table nobody adds to the
  // list leaves a name a plugin may then write to freely, and nothing anywhere
  // says so. This test is what says so, and it fails on the migration that opens
  // the hole rather than on the plugin that finds it.
  const db = tempDb();

  // `type = 'table'` already excludes indexes and views. What it does not exclude
  // is SQLite's own bookkeeping tables — `sqlite_sequence`, `sqlite_stat1` — which
  // appear when a feature that needs them is used and belong to no migration.
  // They are dropped by name prefix rather than by a general filter, and the
  // prefix is safe *because SQLite reserves it*: the assertion below is the proof
  // that this cannot hide a core table, since no migration is able to create one.
  const created = tableNames(db).filter((name) => !name.startsWith("sqlite_"));
  expect(() => db.run("CREATE TABLE sqlite_smuggled (id INTEGER PRIMARY KEY)")).toThrow();

  expect(created).toEqual([...CORE_TABLES].sort());
  db.close();
});

test("placeholders expand to the plugin's namespace, not the name it wrote", () => {
  const { db, plugins } = repo();
  expect(plugins.migrate("pokemon", [CREATE_CAUGHT])).toEqual({ applied: [1] });

  // The name the plugin wrote does not exist; the namespaced one does.
  expect(tableNames(db)).toContain("plugin_pokemon_caught");
  expect(tableNames(db)).not.toContain("caught");

  // And runtime SQL goes through the same expansion, or the table it created at
  // migration time would be unreachable at query time.
  plugins.run("pokemon", "INSERT INTO {{caught}} (id, species) VALUES (?, ?)", [1, "pikachu"]);
  expect(plugins.all<{ species: string }>("pokemon", "SELECT species FROM {{caught}}")).toEqual([
    { species: "pikachu" },
  ]);
  expect(plugins.get<{ species: string }>("pokemon", "SELECT species FROM {{caught}}")).toEqual({
    species: "pikachu",
  });
  db.close();
});

test("two plugins asking for the same table name get different tables", () => {
  const { db, plugins } = repo();
  plugins.migrate("pokemon", [CREATE_CAUGHT]);
  plugins.migrate("digimon", [CREATE_CAUGHT]);

  plugins.run("pokemon", "INSERT INTO {{caught}} (id, species) VALUES (1, 'pikachu')");
  expect(plugins.all("digimon", "SELECT * FROM {{caught}}")).toEqual([]);
  expect(tableNames(db)).toContain("plugin_pokemon_caught");
  expect(tableNames(db)).toContain("plugin_digimon_caught");
  db.close();
});

test("a hyphenated plugin id produces a usable table", () => {
  // `^[a-z][a-z0-9-]{0,31}$` allows hyphens, and `plugin_poke-dex_caught` is a
  // syntax error unless the expansion quotes it.
  const { db, plugins } = repo();
  expect(plugins.migrate("poke-dex", [CREATE_CAUGHT])).toEqual({ applied: [1] });
  plugins.run("poke-dex", "INSERT INTO {{caught}} (id, species) VALUES (1, 'eevee')");
  expect(plugins.all("poke-dex", "SELECT * FROM {{caught}}")).toHaveLength(1);
  expect(plugins.listTables("poke-dex")).toEqual(["plugin_poke-dex_caught"]);
  db.close();
});

test("a hostile placeholder is refused at runtime and at migration", () => {
  const { db, plugins } = repo();
  const hostile = [
    'x" ; DROP TABLE api_keys; --',
    "caught; DROP TABLE credentials",
    "Caught",
    "0caught",
    "caught-1",
    "sqlite_master",
    "",
    " caught ",
    "c".repeat(33),
  ];
  for (const name of hostile) {
    expect(() => plugins.run("pokemon", `SELECT * FROM {{${name}}}`)).toThrow();
  }

  // The same rejection at migration time, where it is reported rather than
  // thrown so a bad plugin cannot take the boot down with it.
  const result = plugins.migrate("pokemon", [
    { version: 1, sql: "CREATE TABLE {{bad name}} (id INTEGER)" },
  ]);
  expect(result.applied).toEqual([]);
  expect(result.failed?.version).toBe(1);
  db.close();
});

test("a reference to a core table is refused", () => {
  const { db, plugins } = repo();
  const forbidden = [
    "SELECT * FROM api_keys",
    "SELECT * FROM request_logs WHERE 1 = 0",
    'DELETE FROM "credentials"',
    "DELETE FROM [settings]",
    "SELECT * FROM usage_rollup",
    "SELECT * FROM usage_daily",
    "SELECT * FROM request_bodies",
    "SELECT * FROM credential_health",
    "SELECT * FROM quota_windows",
    "SELECT * FROM quota_samples",
    "SELECT * FROM virtual_models",
    "DELETE FROM migrations",
    "DELETE FROM plugin_migrations",
    "INSERT INTO {{caught}} SELECT id, model FROM request_logs",
  ];
  for (const sql of forbidden) {
    expect(() => plugins.run("pokemon", sql)).toThrow();
  }

  const result = plugins.migrate("pokemon", [
    CREATE_CAUGHT,
    { version: 2, sql: "INSERT INTO {{caught}} SELECT id, model FROM request_logs" },
  ]);
  expect(result.applied).toEqual([1]);
  expect(result.failed?.version).toBe(2);
  db.close();
});

test("the plugin's own tables are not mistaken for the core ones they end in", () => {
  // `plugin_pokemon_settings` contains `settings`, and a denylist matching on
  // substrings rather than word boundaries would refuse the plugin's own table.
  const { db, plugins } = repo();
  expect(
    plugins.migrate("pokemon", [
      { version: 1, sql: "CREATE TABLE {{settings}} (k TEXT PRIMARY KEY)" },
      { version: 2, sql: "CREATE TABLE {{migrations}} (k TEXT PRIMARY KEY)" },
    ]),
  ).toEqual({ applied: [1, 2] });
  expect(plugins.listTables("pokemon")).toEqual([
    "plugin_pokemon_migrations",
    "plugin_pokemon_settings",
  ]);
  db.close();
});

test("a core name inside a string literal or comment is not a reference", () => {
  // A plugin storing the text `api_keys` in a row is doing nothing wrong, and
  // refusing it would make the guardrail a nuisance without making it a
  // boundary — the plugin shares the process either way.
  const { db, plugins } = repo();
  plugins.migrate("pokemon", [CREATE_CAUGHT]);
  plugins.run("pokemon", "INSERT INTO {{caught}} (id, species) VALUES (1, 'api_keys')");
  plugins.run("pokemon", "-- once read from request_logs\nUPDATE {{caught}} SET species = 'x'");
  plugins.run("pokemon", "/* was credentials */ UPDATE {{caught}} SET species = 'y'");
  // An apostrophe inside a comment must not leave the scanner inside a literal
  // for the rest of the statement.
  plugins.run("pokemon", "-- don't panic\nUPDATE {{caught}} SET species = 'z'");
  expect(plugins.get<{ species: string }>("pokemon", "SELECT species FROM {{caught}}")).toEqual({
    species: "z",
  });
  db.close();
});

test("migrations apply in ascending order regardless of array order", () => {
  const { db, plugins } = repo();
  // Version 2 depends on version 1 having run, and is listed first.
  const result = plugins.migrate("pokemon", [
    { version: 2, sql: "ALTER TABLE {{caught}} ADD COLUMN level INTEGER NOT NULL DEFAULT 1" },
    CREATE_CAUGHT,
  ]);
  expect(result).toEqual({ applied: [1, 2] });
  plugins.run("pokemon", "INSERT INTO {{caught}} (id, species) VALUES (1, 'pikachu')");
  expect(plugins.get<{ level: number }>("pokemon", "SELECT level FROM {{caught}}")).toEqual({
    level: 1,
  });
  db.close();
});

test("each migration commits on its own, so a failure keeps the earlier ones", () => {
  const { db, plugins } = repo();
  const result = plugins.migrate("pokemon", [
    CREATE_CAUGHT,
    { version: 2, sql: "CREATE TABLE {{seen}} (id INTEGER PRIMARY KEY)" },
    { version: 3, sql: "CREATE TABLE {{broken}} (this is not sql" },
    { version: 4, sql: "CREATE TABLE {{never}} (id INTEGER PRIMARY KEY)" },
  ]);

  expect(result.applied).toEqual([1, 2]);
  expect(result.failed?.version).toBe(3);
  expect(typeof result.failed?.reason).toBe("string");

  // 1 and 2 survived the failure of 3 — a single batch transaction would have
  // rolled them back and re-run them on the next boot, forever.
  expect(plugins.listTables("pokemon")).toEqual(["plugin_pokemon_caught", "plugin_pokemon_seen"]);
  // And the walk stopped: 4 was never attempted, because 3 may be what it needs.
  expect(
    db
      .query<{ version: number }, [string]>(
        "SELECT version FROM plugin_migrations WHERE plugin_id = ? ORDER BY version",
      )
      .all("pokemon")
      .map((r) => r.version),
  ).toEqual([1, 2]);
  db.close();
});

test("a failed migration leaves no half-applied schema of its own", () => {
  const { db, plugins } = repo();
  // Two statements in one migration, the second bad: the first must not survive.
  const result = plugins.migrate("pokemon", [
    {
      version: 1,
      sql: "CREATE TABLE {{caught}} (id INTEGER PRIMARY KEY); CREATE TABLE {{seen}} (nope",
    },
  ]);
  expect(result.applied).toEqual([]);
  expect(result.failed?.version).toBe(1);
  expect(plugins.listTables("pokemon")).toEqual([]);
  db.close();
});

test("re-running migrate skips what already applied", () => {
  const { db, plugins } = repo();
  expect(plugins.migrate("pokemon", [CREATE_CAUGHT])).toEqual({ applied: [1] });

  // Same array again: a re-applied `CREATE TABLE` would throw, so an empty
  // `applied` is the only way this can come back clean.
  expect(plugins.migrate("pokemon", [CREATE_CAUGHT])).toEqual({ applied: [] });

  const grown: PluginMigration[] = [
    CREATE_CAUGHT,
    { version: 2, sql: "CREATE TABLE {{seen}} (id INTEGER PRIMARY KEY)" },
  ];
  expect(plugins.migrate("pokemon", grown)).toEqual({ applied: [2] });
  db.close();
});

test("one plugin's applied versions do not count for another", () => {
  const { db, plugins } = repo();
  plugins.migrate("pokemon", [CREATE_CAUGHT]);
  expect(plugins.migrate("digimon", [CREATE_CAUGHT])).toEqual({ applied: [1] });
  db.close();
});

test("migrate does not reorder the caller's array", () => {
  const { db, plugins } = repo();
  const migrations: PluginMigration[] = [
    { version: 2, sql: "CREATE TABLE {{seen}} (id INTEGER PRIMARY KEY)" },
    CREATE_CAUGHT,
  ];
  plugins.migrate("pokemon", migrations);
  expect(migrations.map((m) => m.version)).toEqual([2, 1]);
  db.close();
});

test("transaction rolls the plugin's writes back together", () => {
  const { db, plugins } = repo();
  plugins.migrate("pokemon", [CREATE_CAUGHT]);
  expect(() =>
    plugins.transaction("pokemon", () => {
      plugins.run("pokemon", "INSERT INTO {{caught}} (id, species) VALUES (1, 'pikachu')");
      throw new Error("plugin changed its mind");
    }),
  ).toThrow("plugin changed its mind");
  expect(plugins.all("pokemon", "SELECT * FROM {{caught}}")).toEqual([]);

  expect(
    plugins.transaction("pokemon", () => {
      plugins.run("pokemon", "INSERT INTO {{caught}} (id, species) VALUES (2, 'eevee')");
      return "done";
    }),
  ).toBe("done");
  expect(plugins.all("pokemon", "SELECT * FROM {{caught}}")).toHaveLength(1);
  db.close();
});

test("an unbindable parameter is refused here, naming which one", () => {
  // `bun:sqlite` would throw on this too, so the assertion is on the message:
  // the value of narrowing at the boundary is that the plugin author is told
  // which parameter is wrong, in terms of the call they made, rather than
  // reading a driver-level message about a layer they never touched.
  const { db, plugins } = repo();
  plugins.migrate("pokemon", [CREATE_CAUGHT]);
  expect(() =>
    plugins.run("pokemon", "INSERT INTO {{caught}} (id, species) VALUES (?, ?)", [
      1,
      { species: "pikachu" },
    ]),
  ).toThrow("plugin sql parameter 1 is not a bindable value");
  // Nothing was written on the way to the refusal.
  expect(plugins.all("pokemon", "SELECT * FROM {{caught}}")).toEqual([]);
  db.close();
});

test("get returns null for no row", () => {
  const { db, plugins } = repo();
  plugins.migrate("pokemon", [CREATE_CAUGHT]);
  expect(plugins.get("pokemon", "SELECT * FROM {{caught}} WHERE id = ?", [99])).toBeNull();
  db.close();
});

test("an invalid plugin id is refused everywhere it could become an identifier", () => {
  const { db, plugins } = repo();
  for (const id of ["Pokemon", "poke_mon", "0poke", 'a" OR "1', "", "p".repeat(33)]) {
    expect(() => plugins.migrate(id, [CREATE_CAUGHT])).toThrow();
    expect(() => plugins.run(id, "SELECT 1")).toThrow();
    expect(() => plugins.listTables(id)).toThrow();
    expect(() => plugins.dropAll(id)).toThrow();
    expect(() => plugins.transaction(id, () => 1)).toThrow();
  }
  db.close();
});

test("orphanTables reports tables whose plugin is gone and drops nothing", () => {
  const { db, plugins } = repo();
  plugins.migrate("pokemon", [CREATE_CAUGHT]);
  plugins.migrate("digimon", [CREATE_CAUGHT]);
  plugins.run("pokemon", "INSERT INTO {{caught}} (id, species) VALUES (1, 'pikachu')");

  expect(plugins.orphanTables(["pokemon", "digimon"])).toEqual([]);
  expect(plugins.orphanTables(["digimon"])).toEqual(["plugin_pokemon_caught"]);
  // The restore case: a snapshot from an install that had both, onto one with
  // neither installed yet.
  expect(plugins.orphanTables([])).toEqual(["plugin_digimon_caught", "plugin_pokemon_caught"]);

  // Reporting is all it does. The table and its rows are still there afterwards.
  expect(tableNames(db)).toContain("plugin_pokemon_caught");
  expect(plugins.all("pokemon", "SELECT * FROM {{caught}}")).toHaveLength(1);
  db.close();
});

test("orphanTables never reports core's own plugin_migrations ledger", () => {
  const { db, plugins } = repo();
  plugins.migrate("pokemon", [CREATE_CAUGHT]);
  expect(plugins.orphanTables([])).not.toContain("plugin_migrations");
  expect(plugins.listTables("pokemon")).not.toContain("plugin_migrations");
  db.close();
});

test("orphanTables matches whole prefixes, not string prefixes", () => {
  // `poke` is a prefix of `pokemon`, but plugin `poke` owns none of plugin
  // `pokemon`'s tables and must not be able to claim them.
  const { db, plugins } = repo();
  plugins.migrate("pokemon", [CREATE_CAUGHT]);
  expect(plugins.orphanTables(["poke"])).toEqual(["plugin_pokemon_caught"]);
  db.close();
});

test("dropAll removes only that plugin's tables and returns the count", () => {
  const { db, plugins } = repo();
  plugins.migrate("pokemon", [
    CREATE_CAUGHT,
    { version: 2, sql: "CREATE TABLE {{seen}} (id INTEGER PRIMARY KEY)" },
  ]);
  plugins.migrate("digimon", [CREATE_CAUGHT]);

  expect(plugins.dropAll("pokemon")).toBe(2);
  expect(plugins.listTables("pokemon")).toEqual([]);
  expect(plugins.listTables("digimon")).toEqual(["plugin_digimon_caught"]);
  // Core is untouched, and so is the ledger itself.
  expect(tableNames(db)).toContain("api_keys");
  expect(tableNames(db)).toContain("request_logs");
  expect(tableNames(db)).toContain("plugin_migrations");

  // The ledger rows went with the tables, so a reinstall replays against the
  // empty schema it now actually has rather than believing itself migrated.
  expect(
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM plugin_migrations WHERE plugin_id = ?",
      )
      .get("pokemon")?.n,
  ).toBe(0);
  expect(
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM plugin_migrations WHERE plugin_id = ?",
      )
      .get("digimon")?.n,
  ).toBe(1);
  expect(plugins.migrate("pokemon", [CREATE_CAUGHT])).toEqual({ applied: [1] });
  db.close();
});

test("dropAll on a plugin that never stored anything is zero", () => {
  const { db, plugins } = repo();
  expect(plugins.dropAll("pokemon")).toBe(0);
  db.close();
});
