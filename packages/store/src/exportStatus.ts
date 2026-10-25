import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { SQL } from "bun";

/**
 * Read-only access to the export worker's runtime state, for `omni doctor`.
 * Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Destination* → where `export_state` lives).
 *
 * The worker is the only writer of that state; nothing here writes, migrates
 * or creates. SQLite: `export.db` beside the main file is opened `readonly`
 * with `query_only` on, and a missing file is not created. Postgres: one
 * connection, a `READ ONLY` transaction with a short statement timeout,
 * closed after. Anything unreadable is `null` ("export status unavailable"),
 * never a throw: `doctor` is run when things are wrong.
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

/** One destination as `doctor` needs it: never config, filter or secret. */
export type ExportStatusDestination = {
  id: string;
  generation: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
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

/** How long the Postgres read may take, connect and each statement alike. */
export const STATUS_TIMEOUT_MS = 3_000;

type DestinationRow = {
  id: string;
  generation: string;
  enabled: boolean;
  created_at: number | string;
  updated_at: number | string;
};

/**
 * Destinations and their state from a Postgres store at `url`, or null when
 * the server cannot be reached or either table read. Reads only: a `READ
 * ONLY` transaction, so a write reached by mistake fails; one connection,
 * opened for this call and closed after it.
 */
export async function readPostgresExportStatus(
  url: string,
): Promise<{ destinations: ExportStatusDestination[]; states: ExportStatusRow[] } | null> {
  const sql = new SQL({
    url,
    max: 1,
    connectionTimeout: Math.ceil(STATUS_TIMEOUT_MS / 1000),
    idleTimeout: 1,
  });
  try {
    return await sql.begin("read only", async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${STATUS_TIMEOUT_MS}`);
      const destinations = (await tx.unsafe(
        "SELECT id, generation, enabled, created_at, updated_at FROM export_destinations ORDER BY id",
      )) as DestinationRow[];
      const states = (await tx.unsafe(SELECT)) as Row[];
      return {
        destinations: destinations.map((d) => ({
          id: d.id,
          generation: d.generation,
          enabled: d.enabled,
          createdAt: num(d.created_at),
          updatedAt: num(d.updated_at),
        })),
        states: states.map(toRow),
      };
    });
  } catch {
    return null;
  } finally {
    await sql.close().catch(() => {});
  }
}
