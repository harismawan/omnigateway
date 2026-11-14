import { Database } from "bun:sqlite";

// Shared whole-database enumeration used by password and snapshot comparisons.
export function databaseState(db: Database) {
  return (db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[])
    .map(({name}) => [name, db.query(`SELECT * FROM "${name.replaceAll('"','""')}"`).all()] as const);
}
