import { Database } from "bun:sqlite";
import init001 from "./migrations/001_init.sql" with { type: "text" };
import usageDaily002 from "./migrations/002_usage_daily.sql" with { type: "text" };
import quotaSnapshot003 from "./migrations/003_quota_snapshot.sql" with { type: "text" };
import requestState004 from "./migrations/004_request_state.sql" with { type: "text" };
import rtkMetrics005 from "./migrations/005_rtk_metrics.sql" with { type: "text" };
import rtkUsage006 from "./migrations/006_rtk_usage.sql" with { type: "text" };
import quotaSamples007 from "./migrations/007_quota_samples.sql" with { type: "text" };
import bodyLogging008 from "./migrations/008_body_logging.sql" with { type: "text" };
import keyLimits009 from "./migrations/009_key_limits.sql" with { type: "text" };
import usageRollup010 from "./migrations/010_usage_rollup.sql" with { type: "text" };
import { backfillDaily, backfillRtkUsage, rebuildRollup } from "./rollup.ts";

/**
 * `after` runs inside the migration's own transaction, for the cases where the
 * data step needs the same day arithmetic the runtime uses rather than a SQL
 * approximation of it.
 */
const MIGRATIONS: ReadonlyArray<{ id: number; sql: string; after?: (db: Database) => void }> = [
  { id: 1, sql: init001 },
  { id: 2, sql: usageDaily002, after: backfillDaily },
  { id: 3, sql: quotaSnapshot003 },
  { id: 4, sql: requestState004 },
  { id: 5, sql: rtkMetrics005 },
  { id: 6, sql: rtkUsage006, after: backfillRtkUsage },
  { id: 7, sql: quotaSamples007 },
  { id: 8, sql: bodyLogging008 },
  { id: 9, sql: keyLimits009 },
  // The backfill is the rebuild: seeding a fresh table and repairing a suspect
  // one are the same grouped select, so they cannot drift apart.
  { id: 10, sql: usageRollup010, after: rebuildRollup },
];

/**
 * Opens the database, enables WAL and foreign keys, and applies any migrations
 * not yet recorded. Safe to call on an existing database.
 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(
    "CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );

  const done = new Set(
    db
      .query<{ id: number }, []>("SELECT id FROM migrations")
      .all()
      .map((r) => r.id),
  );

  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      db.run(m.sql);
      m.after?.(db);
      db.run("INSERT INTO migrations (id, applied_at) VALUES (?, ?)", [m.id, Date.now()]);
    })();
  }

  return db;
}
