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
import pluginMigrations011 from "./migrations/011_plugin_migrations.sql" with { type: "text" };
import nodes012 from "./migrations/012_nodes.sql" with { type: "text" };
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
  // Plugin migrations are tracked here but never *applied* here: this array is
  // core's track, and a plugin's track is walked by `PluginRepo.migrate` at
  // load. All migration 011 does is create the ledger that walk writes to.
  { id: 11, sql: pluginMigrations011 },
  { id: 12, sql: nodes012 },
];

/**
 * Opens the database, sets the connection pragmas, and applies any migrations
 * not yet recorded. Safe to call on an existing database.
 *
 * `journal_mode` persists in the file; `synchronous`, `foreign_keys` and
 * `busy_timeout` are per-connection and must be re-applied on every open. That
 * asymmetry is the trap here: a handle opened past this function would still
 * read WAL out of the file and silently revert the other three to their
 * defaults. `reopen()` after a database swap goes through `createStore`'s
 * `open()`, which calls this; keep it that way.
 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  // The single largest cost on the request path, and it is a pragma rather than
  // any amount of doing less work.
  //
  // `synchronous` defaults to FULL, which fsyncs the WAL on every commit. A
  // request commits three or four times — `usage.begin`, `usage.route` on
  // failover, `usage.append` with its two rollups, `credentials.updateHealth` —
  // and `bun:sqlite` is synchronous, so each fsync blocks the whole event loop
  // rather than one request. Measured on xfs, 1,000 iterations after warmup:
  // one health write costs 2,177µs at FULL and 16.4µs at NORMAL, and a
  // request's whole store time 9,076µs against 315µs.
  //
  // What NORMAL gives up, stated exactly, because the first version of this
  // comment got it wrong in the direction that made the trade look safer.
  //
  // It does **not** survive an OS crash. SQLite: a transaction committed in WAL
  // mode at NORMAL "might roll back following a power loss or system crash". A
  // kernel panic is a system crash. Durability across *application* crashes is
  // kept at every setting including OFF, so it is not something NORMAL buys and
  // naming it as one is how the earlier version read as safer than it is.
  //
  // The window is not milliseconds. At NORMAL the WAL is synced at checkpoint,
  // not at commit, so what is exposed is every transaction since the last sync
  // — bounded by the autocheckpoint (1000 pages) or kernel writeback, whichever
  // comes first. Tens of seconds is the right order, and on a quiet install the
  // checkpoint is the far one.
  //
  // What is at stake is mostly replayable — request logs, usage counters,
  // credential health, `usage_rollup` (which commits inside `append`'s
  // transaction, so rows and counters roll back together and `omni doctor`
  // gains no false positive). **One row is not**: `updateSecrets` stores a
  // rotated OAuth refresh token, and the provider has already rotated it, so a
  // rollback there leaves a dead credential needing a browser re-auth rather
  // than a statistic to recompute. That is the real cost of this pragma. It is
  // accepted, not overlooked. Also here and worth knowing: password and API-key
  // hashes, `virtual_models`, `quota_windows`, plugin tables.
  //
  // What WAL gives, and this pragma does not take away, is that the file cannot
  // be *corrupted* by any of the above — that is the guarantee `OFF` would give
  // up and the reason this is NORMAL rather than OFF.
  db.run("PRAGMA synchronous = NORMAL");
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
