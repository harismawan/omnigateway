import type { SQL } from "bun";
import {
  BODY_ROW_CAP,
  decodeArtifact,
  isSafeRequestId,
  prepareArtifact,
  relPathFor,
  sealArtifact,
} from "../bodies/artifact.ts";
import type {
  BodyArtifact,
  BodyArtifactRow,
  BodyDetailState,
  BodyRead,
  BodyRepo,
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
      const row: BodyArtifactRow = {
        requestId: artifact.requestId,
        at: artifact.at,
        relPath,
        sizeBytes: sealed.bytes.length,
        sha256: sealed.sha256,
        detailState: "ready",
        truncated,
      };
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
          sealed.bytes,
        ],
      );
      return row;
    },

    async get(requestId: string): Promise<BodyRead | null> {
      const found = (
        await sql.unsafe<Rows<Row & { bytes: Uint8Array | null }>>(
          "SELECT * FROM request_bodies WHERE request_id = $1",
          [requestId],
        )
      )[0];
      if (found === undefined) return null;

      const row = toRow(found);
      if (row.relPath === null || row.detailState === "none") return { row, artifact: null };

      const read =
        found.bytes === null
          ? { ok: false as const, failure: "missing" as const }
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
