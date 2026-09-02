import { GatewayError } from "@omni/ir";
import type { SQL } from "bun";
import {
  type DatabaseStats,
  type MaintenanceRepo,
  NODE_GRACE_MS,
  type TableStats,
} from "../types.ts";
import { num, type Rows } from "./db.ts";

/**
 * The three file operations do not exist here and say so.
 *
 * `vacuum`, `snapshotTo` and `inspect` are about one file the gateway owns:
 * compacting it, copying it, judging a copy before swapping it in. A Postgres
 * database is not a file this process holds, its backup is `pg_dump`, and a
 * restore is the operator's to perform against the server. A no-op would let
 * `omni db snapshot` report success over nothing, which is the shape a backup
 * failure must never take.
 */
const unsupported = (): never => {
  // Literal text this repository owns, so it may reach stdout in full.
  throw new GatewayError("BAD_REQUEST", "not available on a Postgres store; use pg_dump", {
    gatewayAuthored: true,
  });
};

export function createMaintenanceRepo(sql: SQL, nodeId: string): MaintenanceRepo {
  return {
    async heartbeat(now) {
      await sql.unsafe(
        "INSERT INTO nodes (id, seen_at) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET seen_at = EXCLUDED.seen_at",
        [nodeId, now],
      );
      // A day, not the grace period: `sweepPending` reads absence as death, so
      // a row here is only ever evidence of life and can go once it is stale
      // beyond any question.
      await sql.unsafe("DELETE FROM nodes WHERE seen_at < $1", [now - 86_400_000]);
    },
    async nodes(now) {
      const rows = await sql.unsafe<Rows<{ id: string; seen_at: string }>>(
        "SELECT id, seen_at FROM nodes WHERE seen_at > $1 ORDER BY seen_at DESC",
        [now - NODE_GRACE_MS],
      );
      return rows.map((row) => ({ id: row.id, seenAt: num(row.seen_at) }));
    },
    async stats(): Promise<DatabaseStats> {
      // Page geometry as Postgres reports it: the database's size in its own
      // block size. `freelistCount` is 0 rather than a number: dead tuples are
      // reclaimed by autovacuum per table and there is no whole-database
      // freelist to report, and a figure invented here would be read as one.
      const row = (
        await sql.unsafe<Rows<{ bytes: string; block_size: number; version: number | null }>>(
          `SELECT pg_database_size(current_database()) AS bytes,
                  current_setting('block_size')::int AS block_size,
                  (SELECT MAX(id) FROM migrations) AS version`,
        )
      )[0];
      const pageSize = row?.block_size ?? 0;
      return {
        pageSize,
        pageCount: row === undefined || pageSize === 0 ? 0 : Math.ceil(num(row.bytes) / pageSize),
        freelistCount: 0,
        schemaVersion: row?.version ?? 0,
      };
    },
    async tables(): Promise<TableStats[]> {
      // Planner estimates, not counts: `reltuples` is what ANALYZE last saw
      // and reads as -1 on a table never analysed, which is reported as 0.
      const rows = await sql.unsafe<
        Rows<{ name: string; bytes: string; rows: string; dead_rows: string }>
      >(
        `SELECT c.relname AS name,
                pg_total_relation_size(c.oid) AS bytes,
                GREATEST(c.reltuples, 0)::bigint AS rows,
                COALESCE(s.n_dead_tup, 0) AS dead_rows
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
          WHERE c.relkind = 'r' AND n.nspname = current_schema()
          ORDER BY bytes DESC, name`,
      );
      return rows.map((row) => ({
        name: row.name,
        bytes: num(row.bytes),
        rows: num(row.rows),
        deadRows: num(row.dead_rows),
      }));
    },
    vacuum: async () => unsupported(),
    snapshotTo: async () => unsupported(),
    inspect: async () => unsupported(),
  };
}
