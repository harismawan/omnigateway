import type { SQL } from "bun";
import {
  BODY_ROW_CAP,
  decodeArtifact,
  isSafeRequestId,
  MAX_ENVELOPE_BYTES,
  prepareArtifact,
  relPathFor,
  sealArtifact,
} from "../bodies/artifact.ts";
import type {
  BodyArtifact,
  BodyArtifactRow,
  BodyDetailState,
  BodyPublication,
  BodyRead,
  BodyRepo,
  BodyWritten,
} from "../types.ts";
import { num, type Rows } from "./db.ts";

type Row = {
  request_id: string;
  at: string;
  rel_path: string | null;
  size_bytes: string;
  sha256: string | null;
  detail_state: string;
  truncated: boolean;
};

/** Anything unrecognised reads as `none`: an unknown state promises no bytes. */
function toDetailState(value: string): BodyDetailState {
  return value === "ready" || value === "missing" || value === "corrupt" ? value : "none";
}

const toRow = (r: Row): BodyArtifactRow => ({
  requestId: r.request_id,
  at: num(r.at),
  relPath: r.rel_path,
  sizeBytes: num(r.size_bytes),
  sha256: r.sha256,
  detailState: toDetailState(r.detail_state),
  truncated: r.truncated,
});

/** The row without its payload, which every listing read wants. */
const META = "request_id, at, rel_path, size_bytes, sha256, detail_state, truncated";

/**
 * The body repository, bytes and row in one table.
 *
 * The SQLite store keeps artifacts as files beside the database because a
 * prompt corpus inlined into a single-file database would ride every `VACUUM`
 * and every snapshot. Postgres has no file beside it and `pg_dump` is the
 * backup, so the same encrypted envelope goes into a `bytea` column, written
 * in the same statement as its row. That removes the file/row drift the SQLite
 * repo's `sweepOrphans` exists for — there is nothing here to orphan — while
 * `missing` and `corrupt` stay reportable states, because a row can still be
 * hand-edited to point at bytes it does not have.
 */
export function createBodyRepo(sql: SQL, key: CryptoKey): BodyRepo {
  const removeRows = async (rows: BodyArtifactRow[]): Promise<number> => {
    if (rows.length > 0) {
      await sql.unsafe(
        "DELETE FROM request_bodies WHERE request_id IN (SELECT jsonb_array_elements_text($1::jsonb))",
        [rows.map((row) => row.requestId)],
      );
    }
    return rows.length;
  };

  const recordState = async (requestId: string, state: BodyDetailState): Promise<void> => {
    await sql.unsafe("UPDATE request_bodies SET detail_state = $1 WHERE request_id = $2", [
      state,
      requestId,
    ]);
  };

  const upsert = async (row: BodyArtifactRow, bytes: Uint8Array): Promise<void> => {
    // Upserting rather than inserting, so a retried write of the same request
    // replaces its bytes instead of failing against the primary key.
    await sql.unsafe(
      `INSERT INTO request_bodies
         (request_id, at, rel_path, size_bytes, sha256, detail_state, truncated, bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (request_id) DO UPDATE SET
         at = EXCLUDED.at,
         rel_path = EXCLUDED.rel_path,
         size_bytes = EXCLUDED.size_bytes,
         sha256 = EXCLUDED.sha256,
         detail_state = EXCLUDED.detail_state,
         truncated = EXCLUDED.truncated,
         bytes = EXCLUDED.bytes`,
      [
        row.requestId,
        row.at,
        row.relPath,
        row.sizeBytes,
        row.sha256,
        row.detailState,
        row.truncated,
        bytes,
      ],
    );
  };

  return {
    async put(artifact: BodyArtifact) {
      // The id is no longer a path segment here, but the rule is kept: a row
      // that could not be written on the SQLite store must not be writable on
      // this one, or a restore between the two turns a valid corpus into an
      // invalid one. There is no legitimate id this rejects.
      if (!isSafeRequestId(artifact.requestId)) {
        throw new Error("request id is not safe to use as an artifact path segment");
      }

      const prepared = prepareArtifact(artifact);
      const sealed = await sealArtifact(key, prepared.json);
      const relPath = relPathFor(artifact.requestId, artifact.at);

      const truncated =
        prepared.artifact.client.truncated ||
        prepared.artifact.attempts.some((attempt) => attempt.truncated);
      const row: BodyWritten = {
        requestId: artifact.requestId,
        at: artifact.at,
        relPath,
        sizeBytes: sealed.bytes.length,
        sha256: sealed.sha256,
        detailState: "ready",
        truncated,
        omitted: prepared.omitted,
      };
      await upsert(row, sealed.bytes);
      return row;
    },

    /**
     * The body writer's write, from its own pool: bytes and pointer in one
     * statement, as `put` writes them. The log row's state is `publish`'s to
     * move, on the main pool, so the two writers never contend for one row.
     */
    async writeRow(row: BodyPublication & { bytes: Uint8Array }) {
      if (!isSafeRequestId(row.requestId)) {
        throw new Error("request id is not safe to use as an artifact path segment");
      }
      const inserted = await sql.unsafe(
        `INSERT INTO request_bodies
           (request_id, at, rel_path, size_bytes, sha256, detail_state, truncated, bytes)
         SELECT $1,$2,$3,$4,$5,'ready',$6,$7
          WHERE EXISTS (SELECT 1 FROM request_logs WHERE id = $1 AND body_state = 'pending')
         ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
        [row.requestId, row.at, row.relPath, row.sizeBytes, row.sha256, row.truncated, row.bytes],
      );
      return inserted.length > 0;
    },

    /**
     * The guard on the log row, and the bytes `writeRow` put in place removed in
     * the same transaction when it refuses: a row nobody was waiting for is a
     * body nobody asked to keep. Unless the log row already reads `ready` or
     * `omitted` — a second write of a published request upserted over the
     * first, and deleting it would leave that state pointing at nothing.
     */
    async publish(row: BodyPublication) {
      return sql.begin(async (tx) => {
        const moved = (
          await tx.unsafe(
            `UPDATE request_logs SET body_state = $1 WHERE id = $2 AND body_state = 'pending'
               AND EXISTS (SELECT 1 FROM request_bodies WHERE request_id = $2 AND sha256 = $3)`,
            [row.omitted ? "omitted" : "ready", row.requestId, row.sha256],
          )
        ).count;
        if (moved > 0) return true;
        await tx.unsafe(
          `DELETE FROM request_bodies
            WHERE request_id = $1 AND sha256 = $2
              AND NOT EXISTS (SELECT 1 FROM request_logs
                               WHERE id = $1 AND body_state IN ('ready', 'omitted'))`,
          [row.requestId, row.sha256],
        );
        return false;
      });
    },

    async fail(requestId: string) {
      await sql.unsafe(
        "UPDATE request_logs SET body_state = 'failed' WHERE id = $1 AND body_state = 'pending'",
        [requestId],
      );
    },

    async get(requestId: string): Promise<BodyRead | null> {
      // The column is measured on the server and only sent when it is within
      // the reader's ceiling, so a hostile `bytea` is refused without crossing
      // the wire. The size comes back either way: NULL there means there are no
      // bytes (`missing`), a size with no bytes means too many (`corrupt`).
      const found = (
        await sql.unsafe<
          Rows<Row & { bytes: Uint8Array | null; encoded_size: number | string | null }>
        >(
          `SELECT ${META},
             CASE WHEN octet_length(bytes) <= $2 THEN bytes ELSE NULL END AS bytes,
             octet_length(bytes) AS encoded_size
           FROM request_bodies WHERE request_id = $1`,
          [requestId, MAX_ENVELOPE_BYTES],
        )
      )[0];
      if (found === undefined) return null;

      const row = toRow(found);
      if (row.relPath === null || row.detailState === "none") return { row, artifact: null };

      const read =
        found.encoded_size === null
          ? { ok: false as const, failure: "missing" as const }
          : found.bytes === null
            ? { ok: false as const, failure: "corrupt" as const }
            : await decodeArtifact(key, new Uint8Array(found.bytes), row.sha256);
      if (read.ok) {
        // A row that previously read as missing or corrupt and now reads back is
        // no longer either; the state is an observation, not a verdict.
        if (row.detailState !== "ready") await recordState(requestId, "ready");
        return { row: { ...row, detailState: "ready" }, artifact: read.artifact };
      }

      await recordState(requestId, read.failure);
      return { row: { ...row, detailState: read.failure }, artifact: null };
    },

    async prune(olderThan: number) {
      const rows = await sql.unsafe<Rows<Row>>(`SELECT ${META} FROM request_bodies WHERE at < $1`, [
        olderThan,
      ]);
      return removeRows(rows.map(toRow));
    },

    async pruneToCap(cap = BODY_ROW_CAP) {
      const total = num(
        (await sql.unsafe<Rows<{ n: string }>>("SELECT COUNT(*) AS n FROM request_bodies"))[0]?.n ??
          0,
      );
      if (total <= cap) return 0;
      // `request_id` breaks a tie on `at`, so two rows filed at the same
      // millisecond are pruned in a stable order rather than an arbitrary one.
      const rows = await sql.unsafe<Rows<Row>>(
        `SELECT ${META} FROM request_bodies ORDER BY at ASC, request_id ASC LIMIT $1`,
        [total - cap],
      );
      return removeRows(rows.map(toRow));
    },

    /** Nothing to sweep: bytes and row are one record, written in one statement. */
    async sweepOrphans() {
      return 0;
    },
  };
}
