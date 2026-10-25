import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";

/**
 * Read-only access to the export worker's runtime state, for `omni doctor`.
 * Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Destination* → where `export_state` lives).
 *
 * The worker is the only writer of that state; nothing here writes, migrates
 * or creates: `export.db` beside the main file is opened `readonly` with
 * `query_only` on, and a missing file is not created. Anything unreadable is
 * `null` ("export status unavailable"), never a throw: `doctor` is run when
 * things are wrong. SQLite only, because the CLI administers SQLite
 * installations; a cluster's `export_state` is read by its gateways.
 *
 * A subpath of its own (`@omni/store/exportStatus`), not the package root,
 * like `exportReader`: it reaches state the main store never opens.
 */

/** The worker's state file, beside the main SQLite database. */
export const EXPORT_DB_FILENAME = "export.db";

export function exportDbPathFor(databasePath: string): string {
  return join(dirname(databasePath), EXPORT_DB_FILENAME);
}

/** What `doctor` needs of one `export_state` row: position and health, no counters. */
export type ExportStatusRow = {
  generation: string;
  cursorAt: number;
  caughtUpThrough: number;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  gapPossibleAt: number | null;
};

type Row = {
  generation: string;
  cursor_at: number | string;
  caught_up_through: number | string;
  last_success_at: number | string | null;
  last_error: string | null;
  last_error_at: number | string | null;
  gap_possible_at: number | string | null;
};

const SELECT = `SELECT generation, cursor_at, caught_up_through, last_success_at, last_error,
  last_error_at, gap_possible_at FROM export_state ORDER BY generation`;

const num = (v: number | string): number => Number(v);
const opt = (v: number | string | null): number | null => (v === null ? null : Number(v));

function toRow(r: Row): ExportStatusRow {
  return {
    generation: r.generation,
    cursorAt: num(r.cursor_at),
    caughtUpThrough: num(r.caught_up_through),
    lastSuccessAt: opt(r.last_success_at),
    lastError: r.last_error,
    lastErrorAt: opt(r.last_error_at),
    gapPossibleAt: opt(r.gap_possible_at),
  };
}

/** `export.db`'s rows, or null when the file is missing or unreadable. */
export function readSqliteExportStatus(databasePath: string): ExportStatusRow[] | null {
  let db: Database | null = null;
  try {
    db = new Database(exportDbPathFor(databasePath), { readonly: true });
    db.run("PRAGMA query_only = ON");
    return db.query<Row, []>(SELECT).all().map(toRow);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
