import { Database } from "bun:sqlite";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { noopLogger } from "@omni/ir";
import type { SQL } from "bun";
import {
  acquireArtifact,
  artifactPlaintextLength,
  bodiesDirFor,
  MAX_ENVELOPE_BYTES,
  openArtifactText,
} from "./bodies/artifact.ts";
import { createConfigRepo as pgConfig } from "./postgres/config.ts";
import type { Rows } from "./postgres/db.ts";
import { createExportDestinationRepo as pgDestinations } from "./postgres/exportDestinations.ts";
import { createKeyRepo as pgKeys } from "./postgres/keys.ts";
import { createUsageRepo as pgUsage } from "./postgres/usage.ts";
import { createConfigRepo } from "./sqlite/config.ts";
import { createExportDestinationRepo } from "./sqlite/exportDestinations.ts";
import { createKeyRepo } from "./sqlite/keys.ts";
import { createUsageRepo } from "./sqlite/usage.ts";
import type {
  BodyAdmissionSnapshot,
  ExportDestination,
  ExportPageQuery,
  RequestLog,
  Settings,
} from "./types.ts";

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
  /** One database statement: the policy linearization point for each body send. */
  bodyAdmission(id: string, keyId: string): Promise<BodyAdmissionSnapshot>;
  bodyProbe(id: string): Promise<{ encryptedBytes: number; plaintextBytes: number } | null>;
  bodyEnvelope(
    id: string,
    maxBytes?: number,
  ): Promise<{ bytes: Uint8Array; sha256: string | null; truncated: boolean } | null>;
  bodyText(
    envelope: { bytes: Uint8Array; sha256: string | null },
    expectedPlaintextBytes?: number,
  ): Promise<string | null>;
  keyBodyOptOut(id: string): Promise<boolean>;
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
    bodyAdmission: (id, keyId) => destinations.bodyAdmission(id, keyId),
    async bodyProbe(id) {
      const row = db
        .query<{ rel_path: string | null }, [string]>(
          "SELECT rel_path FROM request_bodies WHERE request_id = ?",
        )
        .get(id);
      if (!row?.rel_path) return null;
      const file = await open(join(bodiesDirFor(path), row.rel_path), "r").catch(() => null);
      if (!file) return null;
      try {
        const { size } = await file.stat();
        const header = new Uint8Array(10);
        await file.read(header, 0, 10, 0);
        const plaintextBytes = artifactPlaintextLength(header, size);
        return plaintextBytes === null ? null : { encryptedBytes: size, plaintextBytes };
      } finally {
        await file.close();
      }
    },
    async bodyEnvelope(id, maxBytes = MAX_ENVELOPE_BYTES) {
      const row = db
        .query<{ rel_path: string | null; sha256: string | null; truncated: number }, [string]>(
          "SELECT rel_path, sha256, truncated FROM request_bodies WHERE request_id = ?",
        )
        .get(id);
      if (!row?.rel_path) return null;
      const bytes = await acquireArtifact(join(bodiesDirFor(path), row.rel_path), maxBytes);
      return bytes instanceof Uint8Array
        ? { bytes, sha256: row.sha256, truncated: Boolean(row.truncated) }
        : null;
    },
    bodyText: (envelope, expected) =>
      expected !== undefined && artifactPlaintextLength(envelope.bytes) !== expected
        ? Promise.resolve(null)
        : openArtifactText(key, envelope.bytes, envelope.sha256),
    async keyBodyOptOut(id) {
      return (
        db
          .query<{ opt: number }, [string]>(
            "SELECT body_logging_opt_out AS opt FROM api_keys WHERE id = ?",
          )
          .get(id)?.opt !== 0
      );
    },
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
  const keys = pgKeys(sql, noopLogger, () => {});
  const destinations = pgDestinations(sql, key);
  return {
    bodyAdmission: (id, keyId) => destinations.bodyAdmission(id, keyId),
    async bodyProbe(id) {
      const row = (
        await sql.unsafe<Rows<{ header: Uint8Array; size: number | string }>>(
          "SELECT substring(bytes from 1 for 10) AS header, octet_length(bytes) AS size FROM request_bodies WHERE request_id = $1",
          [id],
        )
      )[0];
      if (!row?.header) return null;
      const plaintextBytes = artifactPlaintextLength(row.header, Number(row.size));
      return plaintextBytes === null ? null : { encryptedBytes: Number(row.size), plaintextBytes };
    },
    async bodyEnvelope(id, maxBytes = MAX_ENVELOPE_BYTES) {
      const row = (
        await sql.unsafe<
          Rows<{ bytes: Uint8Array | null; sha256: string | null; truncated: boolean }>
        >(
          "SELECT CASE WHEN octet_length(bytes) <= $2 THEN bytes ELSE NULL END AS bytes, sha256, truncated FROM request_bodies WHERE request_id = $1",
          [id, Math.min(maxBytes, MAX_ENVELOPE_BYTES)],
        )
      )[0];
      return row?.bytes ? { bytes: row.bytes, sha256: row.sha256, truncated: row.truncated } : null;
    },
    bodyText: (envelope, expected) =>
      expected !== undefined && artifactPlaintextLength(envelope.bytes) !== expected
        ? Promise.resolve(null)
        : openArtifactText(key, envelope.bytes, envelope.sha256),
    async keyBodyOptOut(id) {
      const row = (
        await sql.unsafe<Rows<{ opt: boolean }>>(
          "SELECT body_logging_opt_out AS opt FROM api_keys WHERE id = $1",
          [id],
        )
      )[0];
      return row?.opt !== false;
    },
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
