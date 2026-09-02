import { expect, test } from "bun:test";
import { CORE_TABLES, POSTGRES_CORE_TABLES } from "../../src/plugins/guard.ts";
import type { PluginMigration } from "../../src/types.ts";
import { forEachStore } from "./harness.ts";

const CREATE_CAUGHT: PluginMigration = {
  version: 1,
  sql: "CREATE TABLE {{caught}} (id INTEGER PRIMARY KEY, species TEXT NOT NULL)",
};

forEachStore((backend) => {
  test("every core table is on the guard's denylist, and nothing else is", async () => {
    // The drift guard, run against each backend's freshly migrated schema:
    // "enumerated rather than derived" is only safe while something enforces
    // the enumeration.
    const s = await backend.fresh();
    await s.plugins.migrate("probe", [CREATE_CAUGHT]);
    const expected =
      backend.name === "sqlite" ? [...CORE_TABLES] : [...CORE_TABLES, ...POSTGRES_CORE_TABLES];
    for (const table of expected) {
      await expect(s.plugins.run("probe", `SELECT 1 FROM ${table}`)).rejects.toThrow(
        `core table ${table}`,
      );
    }
    // Our own table is reachable, so the denylist is a list and not a wall.
    await s.plugins.run("probe", "SELECT 1 FROM {{caught}}");
  });

  test("placeholders expand per plugin, migrations record, and re-runs skip", async () => {
    const s = await backend.fresh();
    expect(await s.plugins.migrate("pokemon", [CREATE_CAUGHT])).toEqual({ applied: [1] });
    expect(await s.plugins.migrate("digimon", [CREATE_CAUGHT])).toEqual({ applied: [1] });
    expect(await s.plugins.migrate("pokemon", [CREATE_CAUGHT])).toEqual({ applied: [] });
    await s.plugins.run("pokemon", "INSERT INTO {{caught}} (id, species) VALUES (1, 'pikachu')");
    expect(await s.plugins.all("pokemon", "SELECT species FROM {{caught}}")).toEqual([
      { species: "pikachu" },
    ]);
    expect(await s.plugins.all("digimon", "SELECT species FROM {{caught}}")).toEqual([]);
    expect(
      await s.plugins.get<{ species: string }>(
        "pokemon",
        "SELECT species FROM {{caught}} WHERE id = 1",
      ),
    ).toEqual({ species: "pikachu" });
    expect(
      await s.plugins.get("pokemon", "SELECT species FROM {{caught}} WHERE id = 2"),
    ).toBeNull();
    expect(await s.plugins.listTables("pokemon")).toEqual(["plugin_pokemon_caught"]);
    expect(await s.plugins.listTables("digimon")).toEqual(["plugin_digimon_caught"]);
  });

  test("each migration commits on its own; a failure keeps the earlier ones and stops", async () => {
    const s = await backend.fresh();
    const result = await s.plugins.migrate("pokemon", [
      { version: 3, sql: "CREATE TABLE {{three}} (id INTEGER)" },
      CREATE_CAUGHT,
      {
        version: 2,
        sql: "CREATE TABLE {{two}} (id INTEGER); CREATE TABLE {{oops}} (id INTEGER); SELECT nope FROM nowhere",
      },
    ]);
    expect(result.applied).toEqual([1]);
    expect(result.failed?.version).toBe(2);
    expect(result.failed?.reason.length).toBeGreaterThan(0);
    // Version 2 left no half-applied schema, and 3 was never attempted.
    expect(await s.plugins.listTables("pokemon")).toEqual(["plugin_pokemon_caught"]);
    // A migration outside the namespace is refused and rolled back.
    const squat = await s.plugins.migrate("pokemon", [
      { version: 2, sql: "CREATE TABLE {{two}} (id INTEGER); CREATE TABLE notes (id INTEGER)" },
    ]);
    expect(squat.failed?.reason).toContain("outside this plugin's namespace");
    expect(await s.plugins.listTables("pokemon")).toEqual(["plugin_pokemon_caught"]);
    expect(await s.plugins.orphanTables([])).not.toContain("notes");
  });

  test("a hostile placeholder, an invalid id, and an unbindable parameter are refused", async () => {
    const s = await backend.fresh();
    await expect(
      s.plugins.run("pokemon", 'CREATE TABLE {{a"; DROP TABLE api_keys; --}} (id INTEGER)'),
    ).rejects.toThrow("must match");
    await expect(s.plugins.run("Bad Id", "SELECT 1")).rejects.toThrow("not a valid identifier");
    await expect(s.plugins.listTables("Bad Id")).rejects.toThrow("not a valid identifier");
    await s.plugins.migrate("pokemon", [CREATE_CAUGHT]);
    await expect(
      s.plugins.run("pokemon", "INSERT INTO {{caught}} (id, species) VALUES ($1, $2)", [
        1,
        { species: "pikachu" },
      ]),
    ).rejects.toThrow("plugin sql parameter 1 is not a bindable value");
    expect(await s.plugins.all("pokemon", "SELECT * FROM {{caught}}")).toEqual([]);
  });

  test("transaction rolls the plugin's writes back together and returns fn's value", async () => {
    const s = await backend.fresh();
    await s.plugins.migrate("pokemon", [CREATE_CAUGHT]);
    await expect(
      s.plugins.transaction("pokemon", async () => {
        await s.plugins.run(
          "pokemon",
          "INSERT INTO {{caught}} (id, species) VALUES (1, 'pikachu')",
        );
        expect(await s.plugins.all("pokemon", "SELECT * FROM {{caught}}")).toHaveLength(1);
        throw new Error("plugin changed its mind");
      }),
    ).rejects.toThrow("plugin changed its mind");
    expect(await s.plugins.all("pokemon", "SELECT * FROM {{caught}}")).toEqual([]);

    expect(
      await s.plugins.transaction("pokemon", async () => {
        await s.plugins.run("pokemon", "INSERT INTO {{caught}} (id, species) VALUES (2, 'eevee')");
        return "done";
      }),
    ).toBe("done");
    expect(await s.plugins.all("pokemon", "SELECT * FROM {{caught}}")).toHaveLength(1);
  });

  test("dropAll removes one plugin's tables and ledger; orphanTables reports and never drops", async () => {
    const s = await backend.fresh();
    await s.plugins.migrate("pokemon", [
      CREATE_CAUGHT,
      { version: 2, sql: "CREATE TABLE {{seen}} (id INTEGER)" },
    ]);
    await s.plugins.migrate("poke", [CREATE_CAUGHT]);
    await s.plugins.migrate("digimon", [CREATE_CAUGHT]);

    // Whole prefixes: `poke` does not own `pokemon`'s tables.
    expect(await s.plugins.orphanTables(["poke", "digimon"])).toEqual([
      "plugin_pokemon_caught",
      "plugin_pokemon_seen",
    ]);
    expect(await s.plugins.orphanTables(["pokemon", "poke", "digimon"])).toEqual([]);
    expect(await s.plugins.orphanTables(["Bad Id"])).toHaveLength(4);
    expect(await s.plugins.orphanTables([])).not.toContain("plugin_migrations");

    expect(await s.plugins.dropAll("pokemon")).toBe(2);
    expect(await s.plugins.listTables("pokemon")).toEqual([]);
    expect(await s.plugins.listTables("poke")).toEqual(["plugin_poke_caught"]);
    expect(await s.plugins.dropAll("pokemon")).toBe(0);
    // The ledger went too, so a reinstall replays from version 1.
    expect(await s.plugins.migrate("pokemon", [CREATE_CAUGHT])).toEqual({ applied: [1] });
  });
});
