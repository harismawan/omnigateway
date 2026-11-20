// Frozen store boundaries: TextEncoder encryption and native SQL parameter binding.
import { Database } from "bun:sqlite";
import { decrypt, deriveKey, encrypt } from "../../packages/store/src/encryption.ts";

const key = await deriveKey("oauth-persistence-probe");
const sqlite = new Database(":memory:");
sqlite.run("CREATE TABLE probe(value TEXT)");
const pg = process.env.OMNI_TEST_DATABASE_URL
  ? new Bun.SQL(process.env.OMNI_TEST_DATABASE_URL)
  : null;
if (pg) await pg.unsafe("CREATE TEMPORARY TABLE probe(value TEXT)");
for (const value of [false, true, 123, {}, [], [1], "\ud800"]) {
  const row: Record<string, unknown> = {
    value,
    secret: await decrypt(key, await encrypt(key, value as string)),
  };
  try {
    sqlite.run("DELETE FROM probe");
    sqlite.run("INSERT INTO probe VALUES (?)", [value as string]);
    row.sqlite = sqlite.query("SELECT value FROM probe").get();
  } catch (e) {
    row.sqliteError = (e as Error).message;
  }
  if (pg) {
    try {
      await pg.unsafe("DELETE FROM probe");
      await pg.unsafe("INSERT INTO probe VALUES ($1)", [value]);
      row.postgres = (await pg.unsafe("SELECT value FROM probe"))[0];
    } catch (e) {
      row.postgresError = (e as Error).message;
    }
  }
  console.log(JSON.stringify(row));
}
sqlite.close();
await pg?.close();
