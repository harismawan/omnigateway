import type { BodyArtifact, BodyDetailState, Store } from "@omni/store";

/**
 * What one request's captured bodies look like to an operator.
 *
 * Deliberately not `BodyRead` from the store. That type carries `relPath` and
 * `sha256`, which describe where the gateway put a file and how it checks it —
 * internal layout that a console has no use for and that an error page should
 * never be able to quote back. What is left is the artifact and the four facts a
 * reader needs to interpret its absence.
 */
export type RequestBodyRead = {
  requestId: string;
  /**
   * Why there is or is not an artifact. `none` means capture never ran for this
   * request; `missing` and `corrupt` mean it did and the file has since gone or
   * stopped being readable. Those are answers, not failures — a file tree and a
   * table that are not written together will drift — so the caller renders the
   * state rather than a 500.
   */
  detailState: BodyDetailState;
  /** True when structural bounding or a mid-stream disconnect cut something. */
  truncated: boolean;
  /** Bytes as stored, which are ciphertext. Zero when nothing was written. */
  sizeBytes: number;
  /** When the artifact was filed, or null when there is no row at all. */
  at: number | null;
  artifact: BodyArtifact | null;
};

/**
 * Reads one request's captured bodies.
 *
 * An admin operation rather than a route handler's business: it is the same
 * question whether it is asked over HTTP or, later, from the CLI, and the rule
 * that a missing or undecryptable artifact is reported rather than raised
 * belongs with the operation, not with one caller's error mapping.
 *
 * A request that was never captured is not an error either. Capture is off by
 * default, so "no row" is the ordinary answer for almost every request on almost
 * every installation, and answering 404 would make the ordinary case look broken.
 */
export async function readRequestBody(store: Store, requestId: string): Promise<RequestBodyRead> {
  const read = await store.bodies.get(requestId);
  if (read === null) {
    return {
      requestId,
      detailState: "none",
      truncated: false,
      sizeBytes: 0,
      at: null,
      artifact: null,
    };
  }

  return {
    requestId: read.row.requestId,
    detailState: read.row.detailState,
    truncated: read.row.truncated,
    sizeBytes: read.row.sizeBytes,
    at: read.row.at,
    artifact: read.artifact,
  };
}
