import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPORT_DB_FILENAME,
  exportDbPathFor,
  readSqliteExportStatus,
} from "../src/exportStatus.ts";

/**
 * `omni doctor`'s read of the export worker's `export.db`: read-only, and
 * null — "export status unavailable" — whenever it cannot be read.
 */

const dir = mkdtempSync(join(tmpdir(), "omni-export-status-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("export.db sits beside the main database", () => {
  expect(EXPORT_DB_FILENAME).toBe("export.db");
  expect(exportDbPathFor(join(dir, "omnigateway.db"))).toBe(join(dir, "export.db"));
});

test("a missing file is unavailable, and is not created", () => {
  const main = join(dir, "missing", "omnigateway.db");
  expect(readSqliteExportStatus(main)).toBeNull();
  expect(Bun.file(exportDbPathFor(main)).size).toBe(0);
});

test("a file without the table is unavailable", () => {
  const sub = mkdtempSync(join(dir, "empty-"));
  new Database(join(sub, "export.db"), { create: true }).close();
  expect(readSqliteExportStatus(join(sub, "omnigateway.db"))).toBeNull();
});

test("rows are read, and the reader never writes", () => {
  const sub = mkdtempSync(join(dir, "rows-"));
  const path = join(sub, "export.db");
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE export_state (
    generation TEXT PRIMARY KEY, cursor_at INTEGER NOT NULL, cursor_id TEXT NOT NULL DEFAULT '',
    epoch INTEGER NOT NULL DEFAULT 0, last_success_at INTEGER, last_error TEXT, last_error_at INTEGER,
    exported_total INTEGER NOT NULL DEFAULT 0, dropped_total INTEGER NOT NULL DEFAULT 0,
    caught_up_through INTEGER NOT NULL DEFAULT 0, seen_retention_lowered_at INTEGER NOT NULL DEFAULT 0,
    gap_possible_at INTEGER, skip_requested_at INTEGER, orphaned_at INTEGER)`);
  db.run(
    "INSERT INTO export_state (generation, cursor_at, last_success_at, last_error, last_error_at, caught_up_through, gap_possible_at) VALUES ('g', 5, 6, 'HTTP 500', 7, 8, 9)",
  );
  const before = db.query<{ v: number }, []>("PRAGMA data_version").get();
  expect(readSqliteExportStatus(join(sub, "omnigateway.db"))).toEqual([
    {
      generation: "g",
      cursorAt: 5,
      caughtUpThrough: 8,
      lastSuccessAt: 6,
      lastError: "HTTP 500",
      lastErrorAt: 7,
      gapPossibleAt: 9,
    },
  ]);
  expect(db.query<{ v: number }, []>("PRAGMA data_version").get()).toEqual(before);
  db.close();
});
