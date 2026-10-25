import type { SQL } from "bun";
import { decrypt, encrypt } from "../encryption.ts";
import {
  DESTINATION_COLUMNS,
  type DestinationRow,
  readDestination,
} from "../exportDestinationRow.ts";
import {
  type ExportDestination,
  type ExportDestinationRepo,
  ExportLimitError,
  MAX_EXPORT_DESTINATIONS,
} from "../types.ts";
import type { Conn, Rows } from "./db.ts";

/** The database clock in epoch ms, so `start_at` and `completed_at` are on one clock. */
const DB_NOW_MS = "(extract(epoch from clock_timestamp()) * 1000)::bigint";

export function createExportDestinationRepo(sql: SQL, key: CryptoKey): ExportDestinationRepo {
  const read = async (id: string, conn: Conn = sql): Promise<ExportDestination | null> => {
    const row = (
      await conn.unsafe<Rows<DestinationRow>>(
        `SELECT ${DESTINATION_COLUMNS} FROM export_destinations WHERE id = $1`,
        [id],
      )
    )[0];
    return row === undefined ? null : readDestination(row);
  };

  return {
    async list() {
      const rows = await sql.unsafe<Rows<DestinationRow>>(
        `SELECT ${DESTINATION_COLUMNS} FROM export_destinations ORDER BY id`,
      );
      return rows.map(readDestination).filter((d): d is ExportDestination => d !== null);
    },

    get: (id) => read(id),

    async create(input) {
      const secret =
        input.secret === undefined || input.secret === null
          ? null
          : await encrypt(key, input.secret);
      const now = Date.now();
      return sql.begin(async (tx): Promise<ExportDestination> => {
        // Serialises creations across replicas, so two cannot both count nine
        // and insert a tenth and an eleventh. Reads are unaffected: the mode
        // conflicts only with writers.
        await tx.unsafe("LOCK TABLE export_destinations IN SHARE ROW EXCLUSIVE MODE");
        const count = Number(
          (await tx.unsafe<Rows<{ n: string }>>("SELECT COUNT(*) AS n FROM export_destinations"))[0]
            ?.n ?? 0,
        );
        if (count >= MAX_EXPORT_DESTINATIONS) throw new ExportLimitError();
        await tx.unsafe(
          `INSERT INTO export_destinations
             (id, generation, type, enabled, config, secret, filter, include_bodies,
              max_request_bytes, start_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                   CASE WHEN $10 THEN ${DB_NOW_MS} ELSE 0 END, $11, $11)`,
          [
            input.id,
            crypto.randomUUID(),
            input.type,
            input.enabled !== false,
            JSON.stringify(input.config),
            secret,
            JSON.stringify(input.filter ?? {}),
            input.includeBodies === true,
            input.maxRequestBytes ?? null,
            // `start_at` from the database clock, never this replica's: the
            // cursor it seeds is compared with `completed_at`, which is
            // stamped from that same clock.
            input.startFrom === "now",
            now,
          ],
        );
        const created = await read(input.id, tx);
        if (created === null) throw new Error(`export destination ${input.id} was not written`);
        return created;
      });
    },

    async update(id, patch) {
      const sets: string[] = [];
      const values: unknown[] = [];
      const put = (column: string, value: unknown): void => {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      };
      if (patch.config !== undefined) put("config", JSON.stringify(patch.config));
      if (patch.filter !== undefined) put("filter", JSON.stringify(patch.filter));
      if (patch.enabled !== undefined) put("enabled", patch.enabled);
      if (patch.includeBodies !== undefined) put("include_bodies", patch.includeBodies);
      if (patch.maxRequestBytes !== undefined) put("max_request_bytes", patch.maxRequestBytes);
      if (patch.secret !== undefined) {
        put("secret", patch.secret === null ? null : await encrypt(key, patch.secret));
      }
      put("updated_at", Date.now());
      values.push(id);
      await sql.unsafe(
        `UPDATE export_destinations SET ${sets.join(", ")} WHERE id = $${values.length}`,
        values,
      );
      return read(id);
    },

    async remove(id) {
      return (await sql.unsafe("DELETE FROM export_destinations WHERE id = $1", [id])).count > 0;
    },

    async openSecret(id) {
      const rows = await sql.unsafe<Rows<{ secret: string | null }>>(
        "SELECT secret FROM export_destinations WHERE id = $1",
        [id],
      );
      const secret = rows[0]?.secret ?? null;
      return secret === null ? null : decrypt(key, secret);
    },
  };
}
