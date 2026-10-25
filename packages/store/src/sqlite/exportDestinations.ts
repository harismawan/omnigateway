import type { Database, SQLQueryBindings } from "bun:sqlite";
import { decrypt, encrypt } from "../encryption.ts";
import {
  DESTINATION_COLUMNS,
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

type StartFrom = ExportDestinationInput["startFrom"];

/**
 * `start_at` per `startFrom`; SQLite is one node, so "now" is the application
 * clock, bound as the creation instant. `afterExisting` reads
 * the newest stamp inside the insert's own transaction, so no completion can
 * land between the read and the row: the cursor `(start_at, '')` is then
 * strictly past every row already held, a same-millisecond one included.
 */
const START_AT: Readonly<Record<StartFrom, string>> = {
  now: "?11",
  oldest: "0",
  afterExisting: "MAX(?11, (SELECT COALESCE(MAX(completed_at), 0) + 1 FROM request_logs))",
};

export function createExportDestinationRepo(db: Database, key: CryptoKey): ExportDestinationRepo {
  const read = (id: string): ExportDestination | null => {
    const row = db
      .query<DestinationRow, [string]>(
        `SELECT ${DESTINATION_COLUMNS} FROM export_destinations WHERE id = ?`,
      )
      .get(id);
    return row === null ? null : readDestination(row);
  };

  /**
   * The cap check and the insert in one `IMMEDIATE` transaction, so the write
   * lock is held across both: another connection cannot insert between the
   * count and the row. Synchronous, so nothing on this connection interleaves.
   */
  const insert = db.transaction((values: SQLQueryBindings[], startFrom: StartFrom): void => {
    const count =
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM export_destinations").get()?.n ?? 0;
    if (count >= MAX_EXPORT_DESTINATIONS) throw new ExportLimitError();
    db.run(
      `INSERT INTO export_destinations
           (id, generation, type, enabled, config, secret, filter, include_bodies,
            max_request_bytes, start_at, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,${START_AT[startFrom]},?10,?11)`,
      values,
    );
  }).immediate;

  return {
    async list() {
      return db
        .query<DestinationRow, []>(
          `SELECT ${DESTINATION_COLUMNS} FROM export_destinations ORDER BY id`,
        )
        .all()
        .map(readDestination)
        .filter((d): d is ExportDestination => d !== null);
    },

    async get(id) {
      return read(id);
    },

    async create(input) {
      // Sealed before the transaction: encryption is async, and the
      // transaction must not await.
      const secret =
        input.secret === undefined || input.secret === null
          ? null
          : await encrypt(key, input.secret);
      // SQLite is one node, so its clock is the application's.
      const now = Date.now();
      insert(
        [
          input.id,
          crypto.randomUUID(),
          input.type,
          input.enabled === false ? 0 : 1,
          JSON.stringify(input.config),
          secret,
          JSON.stringify(input.filter ?? {}),
          input.includeBodies === true ? 1 : 0,
          input.maxRequestBytes ?? null,
          // ?10 created_at, ?11 updated_at — and the instant `start_at` reads.
          now,
          now,
        ],
        input.startFrom,
      );
      const created = read(input.id);
      if (created === null) throw new Error(`export destination ${input.id} was not written`);
      return created;
    },

    async update(id, patch) {
      const sets: string[] = [];
      const values: SQLQueryBindings[] = [];
      const put = (column: string, value: SQLQueryBindings): void => {
        sets.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.config !== undefined) put("config", JSON.stringify(patch.config));
      if (patch.filter !== undefined) put("filter", JSON.stringify(patch.filter));
      if (patch.enabled !== undefined) put("enabled", patch.enabled ? 1 : 0);
      if (patch.includeBodies !== undefined) put("include_bodies", patch.includeBodies ? 1 : 0);
      if (patch.maxRequestBytes !== undefined) put("max_request_bytes", patch.maxRequestBytes);
      if (patch.secret !== undefined) {
        put("secret", patch.secret === null ? null : await encrypt(key, patch.secret));
      }
      put("updated_at", Date.now());
      db.run(`UPDATE export_destinations SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);
      return read(id);
    },

    async remove(id) {
      return db.run("DELETE FROM export_destinations WHERE id = ?", [id]).changes > 0;
    },

    async openSecret(id) {
      const row = db
        .query<{ secret: string | null }, [string]>(
          "SELECT secret FROM export_destinations WHERE id = ?",
        )
        .get(id);
      const secret = row?.secret ?? null;
      return secret === null ? null : decrypt(key, secret);
    },
  };
}
