import { Database, type SQLQueryBindings } from "bun:sqlite";
import { dirname, join } from "node:path";
import { boundMessage, type ExportState, type ExportStateStore, ORPHAN_KEEP_MS } from "../state.ts";
import { commitValues, readState, type StateRow, statements } from "./sql.ts";

/**
 * SQLite's export state: its own file, `export.db`, beside the main database,
 * opened and migrated by the export worker alone. Design: *Destination* →
 * where `export_state` lives, and *Asynchrony* for why it cannot be the main
 * file. Not part of snapshots; a restore swaps the main file and leaves this
 * one, so cursors survive it keyed by generation.
 */
export const EXPORT_DB_FILENAME = "export.db";

export function exportDbPathFor(databasePath: string): string {
  return join(dirname(databasePath), EXPORT_DB_FILENAME);
}

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
});

export function openSqliteExportState(path: string): ExportStateStore {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  // A commit lost to an OS crash is a batch resent: at-least-once, which the
  // design already accepts. Corruption is what WAL rules out at any setting.
  db.run("PRAGMA synchronous = NORMAL");
  // A restarted worker may open this file while a terminated one's last write
  // is still landing; wait for it rather than fail the pass.
  db.run("PRAGMA busy_timeout = 5000");
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
    async commit(generation, epoch, next) {
      return changed(SQL.commit, [generation, epoch, ...commitValues(next)]);
    },
    async recordError(generation, epoch, message, at) {
      return changed(SQL.recordError, [generation, epoch, boundMessage(message), at]);
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
