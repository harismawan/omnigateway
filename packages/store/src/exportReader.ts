import { Database } from "bun:sqlite";
import { noopLogger } from "@omni/ir";
import type { SQL } from "bun";
import { createConfigRepo as pgConfig } from "./postgres/config.ts";
import type { Rows } from "./postgres/db.ts";
import { createExportDestinationRepo as pgDestinations } from "./postgres/exportDestinations.ts";
import { createKeyRepo as pgKeys } from "./postgres/keys.ts";
import { createUsageRepo as pgUsage } from "./postgres/usage.ts";
import { createConfigRepo } from "./sqlite/config.ts";
import { createExportDestinationRepo } from "./sqlite/exportDestinations.ts";
import { createKeyRepo } from "./sqlite/keys.ts";
import { createUsageRepo } from "./sqlite/usage.ts";
import type { ExportDestination, ExportPageQuery, RequestLog, Settings } from "./types.ts";

/**
 * What the export worker reads from the main database, and nothing else: no
 * method here writes. Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Asynchrony* → the worker never writes the main SQLite file).
 *
 * Built from the store's own repos rather than a second copy of their SQL, so
 * the cursor read, the destination row reader and the settings parser are the
 * ones the contract suite already pins. Only read methods are exposed; on
 * SQLite the handle is opened `readonly` with `query_only` on as well, so a
 * write reached by mistake throws instead of taking the writer lock or moving
 * `PRAGMA data_version` (which rebuilds the routing snapshot).
 *
 * A subpath of its own (`@omni/store/exportReader`), not part of the package
 * root: the gateway pins that only the export worker imports it.
 */
export type ExportReader = {
  /** Every destination, by id, never with its secret. */
  destinations(): Promise<ExportDestination[]>;
  /**
   * The destination and its decrypted secret from **one** read, so they are
   * the same version of the row — never a config from one read paired with a
   * secret from another. Null when no destination has that id.
   */
  destinationWithSecret(
    id: string,
  ): Promise<{ destination: ExportDestination; secret: string | null } | null>;
  settings(): Promise<Settings>;
  /** Key id → label, for the records' `apiKey.label`. */
  keyLabels(): Promise<Map<string, string>>;
  exportPage(q: ExportPageQuery): Promise<RequestLog[]>;
  /** One row by id, for the console's *Preview record*. */
  getLog(id: string): Promise<RequestLog | null>;
  /**
   * The settle clock, epoch ms: the injected clock on SQLite (one node, one
   * clock), the database clock on Postgres — the one `completed_at` is
   * stamped from, so a replica's skew cannot overtake a committing row.
   */
  now(): Promise<number>;
  /** Idempotent. Releases what this reader opened; a pool passed in stays the caller's. */
  close(): void;
};

const NO_NODE = "export-reader";

/**
 * A reader over the SQLite main file at `path`, opened read-only. Never
 * creates or migrates: the gateway's main thread did that before starting the
 * worker, and a missing file is an error, not an empty database.
 */
export function openSqliteExportReader(
  path: string,
  key: CryptoKey,
  now: () => number,
): ExportReader {
  const db = new Database(path, { readonly: true });
  // The main connection's per-connection pragmas, minus those that write.
  // `journal_mode` is the file's (WAL), read from it; a WAL reader never
  // blocks the writer.
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA query_only = ON");
  const usage = createUsageRepo(db, NO_NODE);
  const config = createConfigRepo(db);
  const keys = createKeyRepo(db);
  const destinations = createExportDestinationRepo(db, key);
  let closed = false;
  return {
    destinations: () => destinations.list(),
    destinationWithSecret: (id) => destinations.openWithSecret(id),
    settings: () => config.getSettings(),
    keyLabels: async () => labels(await keys.list()),
    exportPage: (q) => usage.exportPage(q),
    getLog: (id) => usage.get(id),
    now: async () => now(),
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

const DB_NOW_MS = "SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS now";

/** A reader over the worker's own pool; the pool is the caller's to close. */
export function createPostgresExportReader(sql: SQL, key: CryptoKey): ExportReader {
  const usage = pgUsage(sql, NO_NODE, 0);
  const config = pgConfig(sql, () => {});
  const keys = pgKeys(sql, noopLogger);
  const destinations = pgDestinations(sql, key);
  return {
    destinations: () => destinations.list(),
    destinationWithSecret: (id) => destinations.openWithSecret(id),
    settings: () => config.getSettings(),
    keyLabels: async () => labels(await keys.list()),
    exportPage: (q) => usage.exportPage(q),
    getLog: (id) => usage.get(id),
    async now() {
      const row = (await sql.unsafe<Rows<{ now: string | number }>>(DB_NOW_MS))[0];
      if (row === undefined) throw new Error("database clock read returned no row");
      return Number(row.now);
    },
    close() {
      // The pool is the caller's.
    },
  };
}

function labels(keys: ReadonlyArray<{ id: string; label: string }>): Map<string, string> {
  return new Map(keys.map((k) => [k.id, k.label]));
}
