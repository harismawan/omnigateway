import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  boundMessage,
  CommitTimeoutError,
  type ExportState,
  type ExportStateStore,
  ORPHAN_KEEP_MS,
  remainingMs,
} from "../state.ts";
import { commitValues, readState, type StateRow, statements } from "./sql.ts";

/**
 * SQLite's export state: its own file, `export.db`, beside the main database,
 * opened and migrated by the export worker alone. Design: *Destination* →
 * where `export_state` lives, and *Asynchrony* for why it cannot be the main
 * file. Not part of snapshots; a restore swaps the main file and leaves this
 * one, so cursors survive it keyed by generation. Where it is
 * (`exportDbPathFor`) lives in `@omni/store/exportStatus`, beside the
 * read-only reader `omni doctor` opens it with, so the two cannot disagree.
 */
export { EXPORT_DB_FILENAME, exportDbPathFor } from "@omni/store/exportStatus";

/**
 * The schema, versioned by `PRAGMA user_version`: one table, the same columns
 * as Postgres `010_log_export.sql`'s `export_state`. A later change appends a
 * step here and bumps the version; steps never edit in place.
 */
const SCHEMA: readonly string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS export_state (
      generation                TEXT PRIMARY KEY,
      cursor_at                 INTEGER NOT NULL,
      cursor_id                 TEXT NOT NULL DEFAULT '',
      epoch                     INTEGER NOT NULL DEFAULT 0,
      last_success_at           INTEGER,
      last_error                TEXT,
      last_error_at             INTEGER,
      exported_total            INTEGER NOT NULL DEFAULT 0,
      dropped_total             INTEGER NOT NULL DEFAULT 0,
      caught_up_through         INTEGER NOT NULL DEFAULT 0,
      seen_retention_lowered_at INTEGER NOT NULL DEFAULT 0,
      gap_possible_at           INTEGER,
      skip_requested_at         INTEGER,
      orphaned_at               INTEGER
    )`,
  ],
  // 2: the shared retry schedule (see `ExportState.retryAt`).
  [
    "ALTER TABLE export_state ADD COLUMN retry_at INTEGER",
    "ALTER TABLE export_state ADD COLUMN retry_for_updated_at INTEGER",
    "ALTER TABLE export_state ADD COLUMN failing INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE export_state ADD COLUMN failures INTEGER NOT NULL DEFAULT 0",
  ],
];

function migrate(db: Database): void {
  db.transaction(() => {
    const version =
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    for (let v = version; v < SCHEMA.length; v++) {
      for (const statement of SCHEMA[v] ?? []) db.run(statement);
    }
    if (version < SCHEMA.length) db.run(`PRAGMA user_version = ${SCHEMA.length}`);
  }).immediate();
}

const SQL = statements({
  p: (n) => `?${n}`,
  greatest: "max",
  jsonSet: (param) => `(SELECT value FROM json_each(${param}))`,
  false: "0",
});

const BUSY_TIMEOUT_MS = 5000;

export function openSqliteExportState(path: string): ExportStateStore {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  // A commit lost to an OS crash is a batch resent: at-least-once, which the
  // design already accepts. Corruption is what WAL rules out at any setting.
  db.run("PRAGMA synchronous = NORMAL");
  // A restarted worker may open this file while a terminated one's last write
  // is still landing; wait for it rather than fail the pass.
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  migrate(db);

  let closed = false;
  const changed = (sql: string, args: SQLQueryBindings[]): boolean => db.run(sql, args).changes > 0;

  const sweep = db.transaction((live: string, now: number, keepMs: number): number => {
    db.run(SQL.unorphan, [live]);
    db.run(SQL.orphan, [live, now]);
    return db.run(SQL.deleteOrphans, [live, now - keepMs]).changes;
  });

  return {
    async ensure(generation, startAt) {
      db.run(SQL.ensure, [generation, startAt]);
    },
    async claim(generation) {
      const row = db.query<StateRow, [string]>(SQL.claim).get(generation);
      return row === null ? null : readState(row);
    },
    async commit(generation, epoch, next, bound) {
      const values = [generation, epoch, ...commitValues(next)];
      if (bound === undefined) return changed(SQL.commit, values);
      const ms = remainingMs(bound);
      // The write is synchronous: once it holds the lock it finishes. What can
      // outlast the deadline is waiting for the lock, so that wait is bounded
      // by the time left, for this statement only.
      db.run(`PRAGMA busy_timeout = ${Math.min(ms, BUSY_TIMEOUT_MS)}`);
      try {
        return changed(SQL.commit, values);
      } catch (error) {
        if ((error as { code?: unknown }).code === "SQLITE_BUSY") throw new CommitTimeoutError();
        throw error;
      } finally {
        db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      }
    },
    async recordError(generation, epoch, message, at, schedule) {
      if (schedule === undefined) {
        return changed(SQL.recordError, [generation, epoch, boundMessage(message), at]);
      }
      return changed(SQL.recordFailure, [
        generation,
        epoch,
        boundMessage(message),
        at,
        schedule.retryAt,
        schedule.forUpdatedAt,
        schedule.failing ? 1 : 0,
        schedule.failures,
      ]);
    },
    flagGap: async (generation, at) => changed(SQL.flagGap, [generation, at]),
    clearGap: async (generation, seenAt) => changed(SQL.clearGap, [generation, seenAt]),
    requestSkip: async (generation, at) => changed(SQL.requestSkip, [generation, at]),
    clearSkip: async (generation, at) => changed(SQL.clearSkip, [generation, at]),
    async list(): Promise<ExportState[]> {
      return db.query<StateRow, []>(SQL.list).all().map(readState);
    },
    async deleteOrphans(liveGenerations, now, keepMs = ORPHAN_KEEP_MS) {
      return sweep.immediate(JSON.stringify(liveGenerations), now, keepMs);
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
