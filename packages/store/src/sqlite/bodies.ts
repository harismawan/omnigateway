import type { Database } from "bun:sqlite";
import {
  BODY_ROW_CAP,
  deleteArtifact,
  isSafeRequestId,
  listArtifacts,
  prepareArtifact,
  readArtifact,
  relPathFor,
  sealArtifact,
  writeArtifact,
} from "../bodies/artifact.ts";
import type {
  BodyArtifact,
  BodyArtifactRow,
  BodyDetailState,
  BodyRead,
  BodyRepo,
} from "../types.ts";

type Row = {
  request_id: string;
  at: number;
  rel_path: string | null;
  size_bytes: number;
  sha256: string | null;
  detail_state: string;
  truncated: number;
};

/** Anything unrecognised reads as `none`: an unknown state promises no file. */
function toDetailState(value: string): BodyDetailState {
  return value === "ready" || value === "missing" || value === "corrupt" ? value : "none";
}

const toRow = (r: Row): BodyArtifactRow => ({
  requestId: r.request_id,
  at: r.at,
  relPath: r.rel_path,
  sizeBytes: r.size_bytes,
  sha256: r.sha256,
  detailState: toDetailState(r.detail_state),
  truncated: r.truncated === 1,
});

/**
 * The body repository: rows here, artifacts on disk, and one write path.
 *
 * `dir` is derived from the database path by `createStore` rather than
 * configured, because an artifact tree that can be pointed somewhere else is a
 * tree an operator can lose track of, and a prompt corpus is the last thing that
 * should be able to end up somewhere nobody is backing up or nobody is deleting.
 */
export function createBodyRepo(db: Database, key: CryptoKey, dir: string): BodyRepo {
  /**
   * Deletes files and rows together, in that order.
   *
   * File first, because the row is what a later sweep uses to find the file: a
   * crash between the two leaves an orphan file, which the orphan sweep cleans
   * up, whereas the other order leaves a row pointing at nothing and no way to
   * tell it from one whose file was deleted underneath it.
   */
  const removeRows = async (rows: BodyArtifactRow[]): Promise<number> => {
    for (const row of rows) {
      if (row.relPath !== null) await deleteArtifact(dir, row.relPath);
    }
    const remove = db.prepare<unknown, [string]>("DELETE FROM request_bodies WHERE request_id = ?");
    db.transaction(() => {
      for (const row of rows) remove.run(row.requestId);
    })();
    return rows.length;
  };

  const recordState = (requestId: string, state: BodyDetailState): void => {
    db.run("UPDATE request_bodies SET detail_state = ? WHERE request_id = ?", [state, requestId]);
  };

  return {
    async put(artifact: BodyArtifact) {
      // Before anything is masked, bounded, or written: the id becomes a path
      // segment, and a hostile one containing a separator would write outside
      // the shard directory. There is no legitimate id this rejects.
      if (!isSafeRequestId(artifact.requestId)) {
        throw new Error("request id is not safe to use as an artifact path segment");
      }

      const prepared = prepareArtifact(artifact);
      const sealed = await sealArtifact(key, prepared.json);
      const relPath = relPathFor(artifact.requestId, artifact.at);
      await writeArtifact(dir, relPath, sealed.bytes);

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
      // replaces its pointer instead of failing against the primary key.
      db.run(
        `INSERT INTO request_bodies (request_id, at, rel_path, size_bytes, sha256, detail_state, truncated)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (request_id) DO UPDATE SET
           at = excluded.at,
           rel_path = excluded.rel_path,
           size_bytes = excluded.size_bytes,
           sha256 = excluded.sha256,
           detail_state = excluded.detail_state,
           truncated = excluded.truncated`,
        [
          row.requestId,
          row.at,
          row.relPath,
          row.sizeBytes,
          row.sha256,
          row.detailState,
          row.truncated ? 1 : 0,
        ],
      );
      return row;
    },

    async get(requestId: string): Promise<BodyRead | null> {
      const found = db
        .query<Row, [string]>("SELECT * FROM request_bodies WHERE request_id = ?")
        .get(requestId);
      if (found === null) return null;

      const row = toRow(found);
      if (row.relPath === null || row.detailState === "none") return { row, artifact: null };

      const read = await readArtifact(key, dir, row.relPath, row.sha256);
      if (read.ok) {
        // A row that previously read as missing or corrupt and now reads back is
        // no longer either; the state is an observation, not a verdict.
        if (row.detailState !== "ready") recordState(requestId, "ready");
        return { row: { ...row, detailState: "ready" }, artifact: read.artifact };
      }

      recordState(requestId, read.failure);
      return { row: { ...row, detailState: read.failure }, artifact: null };
    },

    async prune(olderThan: number) {
      const rows = db
        .query<Row, [number]>("SELECT * FROM request_bodies WHERE at < ?")
        .all(olderThan)
        .map(toRow);
      return removeRows(rows);
    },

    async pruneToCap(cap = BODY_ROW_CAP) {
      const total =
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM request_bodies").get()?.n ?? 0;
      if (total <= cap) return 0;
      // `request_id` breaks a tie on `at`, so two rows filed at the same
      // millisecond are pruned in a stable order rather than an arbitrary one.
      const rows = db
        .query<Row, [number]>(
          "SELECT * FROM request_bodies ORDER BY at ASC, request_id ASC LIMIT ?",
        )
        .all(total - cap)
        .map(toRow);
      return removeRows(rows);
    },

    /**
     * Removes artifact files no row points at.
     *
     * The snapshot below is a filter, not the decision. `put` writes the file
     * and *then* inserts its row, and walking a tree of a hundred thousand files
     * is not instantaneous, so a request that completes between the two is a
     * file the walk lists and a row the snapshot predates: sweeping on the
     * snapshot alone deletes a live artifact, whose row goes on claiming `ready`
     * until a reader discovers it as `missing`.
     *
     * So every candidate is re-asked for immediately before its unlink, which
     * closes the window to the width of one synchronous query. The alternative —
     * sparing files younger than some grace period — would work too, but it
     * trades a real guarantee for a guessed duration, and the guess has to
     * outlast the slowest tree walk on the slowest disk anyone runs this on. The
     * snapshot stays because it answers for almost every file without a query;
     * the re-check only runs for the few it does not recognise.
     */
    async sweepOrphans() {
      const known = new Set(
        db
          .query<{ rel_path: string }, []>(
            "SELECT rel_path FROM request_bodies WHERE rel_path IS NOT NULL",
          )
          .all()
          .map((r) => r.rel_path),
      );
      const claimed = db.query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM request_bodies WHERE rel_path = ?",
      );
      let removed = 0;
      for (const rel of await listArtifacts(dir)) {
        if (known.has(rel)) continue;
        if ((claimed.get(rel)?.n ?? 0) > 0) continue;
        await deleteArtifact(dir, rel);
        removed += 1;
      }
      return removed;
    },
  };
}
