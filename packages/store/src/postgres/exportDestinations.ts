import type { SQL } from "bun";
import { decrypt, encrypt } from "../encryption.ts";
import {
  DESTINATION_COLUMNS,
  DESTINATION_WITH_SECRET_COLUMNS,
  type DestinationRow,
  readDestination,
} from "../exportDestinationRow.ts";
import {
  type ExportDestination,
  type ExportDestinationInput,
  type ExportDestinationRepo,
  ExportLimitError,
  MAX_EXPORT_DESTINATIONS,
} from "../types.ts";
import type { Conn, Rows } from "./db.ts";

/** The database clock in epoch ms, so `start_at` and `completed_at` are on one clock. */
const DB_NOW_MS = "(extract(epoch from clock_timestamp()) * 1000)::bigint";

/**
 * `start_at` per `startFrom`, from the database clock, never this replica's:
 * the cursor it seeds is compared with `completed_at`, stamped from that same
 * clock. `afterExisting` is one past the newest stamp already held (or now,
 * whichever is later), so the cursor `(start_at, '')` is strictly past every
 * existing row, a same-millisecond one included. A completion committing
 * concurrently with it is not covered; the one caller (`copyStore`) writes
 * into a store nothing else is serving.
 */
const START_AT: Readonly<Record<ExportDestinationInput["startFrom"], string>> = {
  now: DB_NOW_MS,
  oldest: "0",
  afterExisting: `GREATEST(${DB_NOW_MS}, (SELECT COALESCE(MAX(completed_at), 0) + 1 FROM request_logs))`,
};

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
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, ${START_AT[input.startFrom]}, $10, $10)`,
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
      sets.push("revision = revision + 1");
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

    async openWithSecret(id) {
      const row = (
        await sql.unsafe<Rows<DestinationRow & { secret: string | null }>>(
          `SELECT ${DESTINATION_WITH_SECRET_COLUMNS} FROM export_destinations WHERE id = $1`,
          [id],
        )
      )[0];
      if (row === undefined) return null;
      const destination = readDestination(row);
      if (destination === null) return null;
      return {
        destination,
        secret: row.secret === null ? null : await decrypt(key, row.secret),
      };
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
