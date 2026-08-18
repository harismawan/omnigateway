import { Database } from "bun:sqlite";
import type { DatabaseInspection, DatabaseStats, MaintenanceRepo } from "../types.ts";

/**
 * The tables a file must have to be one of ours.
 *
 * Deliberately the set created by migration 001 rather than every table that
 * exists today: a snapshot taken at an older schema is still a valid restore
 * source, because `openDb` migrates it forward on the way in. Asserting the
 * current set would reject exactly the old backup an operator reaches for.
 */
const REQUIRED_TABLES = [
  "api_keys",
  "credential_health",
  "credentials",
  "migrations",
  "quota_windows",
  "request_logs",
  "settings",
  "virtual_models",
] as const;

/** What `inspect` reports for a file that is not a database at all. */
const UNREADABLE = "unreadable";

/**
 * A path as a SQL string literal.
 *
 * `VACUUM INTO` takes an expression, not a statement parameter that every
 * SQLite build binds the same way, so the destination is spliced in as a
 * literal. Doubling the single quote is the whole of SQLite's string escape —
 * there is no backslash form to also handle — and a path is the one thing here
 * an operator can name.
 */
function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createMaintenanceRepo(db: Database): MaintenanceRepo {
  return {
    async stats(): Promise<DatabaseStats> {
      // Raw pragmas through the query API, as the `data_version` read in
      // `store.ts` already does: there is no other way to ask SQLite this.
      const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get();
      const pageCount = db.query<{ page_count: number }, []>("PRAGMA page_count").get();
      const freelist = db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get();
      const version = db
        .query<{ version: number | null }, []>("SELECT MAX(id) AS version FROM migrations")
        .get();
      return {
        pageSize: pageSize?.page_size ?? 0,
        pageCount: pageCount?.page_count ?? 0,
        freelistCount: freelist?.freelist_count ?? 0,
        schemaVersion: version?.version ?? 0,
      };
    },

    async vacuum(): Promise<void> {
      db.run("VACUUM");
      // The rewrite lands in the write-ahead log, so without this the page
      // count falls while the file on disk keeps every page it had. Every
      // caller measures the file to report what compaction returned, and an
      // operator reading "0 bytes reclaimed" after a successful vacuum learns
      // the wrong thing about their disk.
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    },

    async snapshotTo(path: string): Promise<void> {
      db.run(`VACUUM INTO ${sqlLiteral(path)}`);
    },

    async inspect(path: string): Promise<DatabaseInspection> {
      let file: Database;
      try {
        // Read-only, and a separate handle: the live database is not opened,
        // locked, or checkpointed by the act of judging a candidate file.
        file = new Database(path, { readonly: true });
      } catch {
        return { ok: false, quickCheck: UNREADABLE, tables: [], counts: {} };
      }
      try {
        // `quick_check` returns the single row `ok`, or one row per problem.
        const problems = file.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
        const quickCheck = problems[0]?.quick_check ?? UNREADABLE;
        const tables = file
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
              "ORDER BY name",
          )
          .all()
          .map((r) => r.name);

        const present = new Set(tables);
        const counts: Record<string, number> = {};
        for (const table of REQUIRED_TABLES) {
          if (!present.has(table)) continue;
          // Interpolated from a module constant, never from the caller.
          const n = file.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get();
          counts[table] = n?.n ?? 0;
        }

        const complete = REQUIRED_TABLES.every((t) => present.has(t));
        return { ok: quickCheck === "ok" && complete, quickCheck, tables, counts };
      } catch {
        // A file that opens but cannot be read past its header is as unusable
        // as one that never opened, and says so the same way.
        return { ok: false, quickCheck: UNREADABLE, tables: [], counts: {} };
      } finally {
        file.close();
      }
    },
  };
}
