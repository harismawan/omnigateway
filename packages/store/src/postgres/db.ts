import { SQL } from "bun";
import init001 from "./migrations/001_init.sql" with { type: "text" };

/**
 * Anything that can run a statement: the pool, a reserved connection, or the
 * scoped handle `sql.begin` supplies. Every repo is written against this so a
 * function serves inside and outside a transaction alike.
 */
export type Conn = Pick<SQL, "unsafe">;

/** What `unsafe` resolves to: the rows, plus the affected-row count for writes. */
export type Rows<T> = T[] & { count: number };

/**
 * `BIGINT` arrives as a string, because the driver will not narrow a 64-bit
 * column into a double on its own. Every timestamp and every counter in this
 * schema is one, so every reader converts at the mapper — the same place the
 * SQLite repo turns `0`/`1` into a boolean.
 */
export const num = (v: string | number): number => Number(v);
export const numOrNull = (v: string | number | null): number | null =>
  v === null ? null : Number(v);

/**
 * The advisory lock every migration walk — core's and each plugin's — takes.
 *
 * One fixed key, so N replicas booting together serialise and the later ones
 * find nothing to apply. Arbitrary but stable; changing it would let two
 * versions of the gateway migrate the same database at once.
 */
export const MIGRATION_LOCK = 7_140_641;

const MIGRATIONS: ReadonlyArray<{ id: number; sql: string }> = [{ id: 1, sql: init001 }];

/**
 * Opens the pool and applies any migrations not yet recorded. Safe to call on
 * an existing database.
 *
 * The walk holds a session-level advisory lock on one reserved connection for
 * its whole duration, and reads the applied set *after* taking it: a replica
 * that queued behind another's walk then sees that walk's rows rather than the
 * empty ledger it would have read a moment earlier.
 */
export async function openPg(url: string): Promise<SQL> {
  const sql = new SQL({ url });
  const conn = await sql.reserve();
  try {
    await conn.unsafe(`SELECT pg_advisory_lock(${MIGRATION_LOCK})`);
    try {
      await conn.unsafe(
        "CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)",
      );
      const done = new Set(
        (await conn.unsafe<Rows<{ id: number }>>("SELECT id FROM migrations")).map((r) => r.id),
      );
      for (const m of MIGRATIONS) {
        if (done.has(m.id)) continue;
        await conn.unsafe("BEGIN");
        try {
          await conn.unsafe(m.sql);
          await conn.unsafe("INSERT INTO migrations (id, applied_at) VALUES ($1, $2)", [
            m.id,
            Date.now(),
          ]);
          await conn.unsafe("COMMIT");
        } catch (error) {
          await conn.unsafe("ROLLBACK");
          throw error;
        }
      }
    } finally {
      await conn.unsafe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`);
    }
  } finally {
    conn.release();
  }
  return sql;
}
