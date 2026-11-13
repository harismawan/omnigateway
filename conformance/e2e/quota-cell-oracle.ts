// Read the frozen router predicate rather than maintaining a second oracle.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../../packages/router/src/filters.ts", import.meta.url), "utf8");
const predicate = source.match(/w\.limit !== null && w\.used >= w\.limit/);
if (!predicate) throw new Error("frozen quota predicate changed");
const spent = new Function("w", `return ${predicate[0]}`);
const cells = ["9", "10.5", "'9'", "'unknown'", "''", "x'09'", "x'0a'", "x''", "x'090a'", "NULL"];
const db = new Database(":memory:");
for (const used of cells) for (const limit of cells) {
  const row = db.query(`SELECT ${used} AS used, ${limit} AS 'limit'`).get();
  console.log(JSON.stringify({used, limit, spent: spent(row)}));
}
