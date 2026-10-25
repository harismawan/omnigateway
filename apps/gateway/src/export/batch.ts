/**
 * Cutting encoded records into request-sized batches. Pure.
 *
 * Design caps (*Delivery*, Batch): at most 500 records and 5 MiB encoded,
 * whichever comes first. Bytes are UTF-8 and include the destination format's
 * envelope — the fixed text around the records and the separator between two —
 * which each encoder declares as a {@link BatchEnvelope}. Compression is not
 * counted: the cap bounds what is built in memory, and gzip only shrinks it.
 *
 * A single record whose part alone exceeds the byte cap is not split and not
 * dropped: it goes alone in its own batch. A metadata record is a few KiB at
 * most (every free-text field is bounded at ingress), so this cannot
 * realistically happen in part 1; body export (part 2) segments large bodies
 * into separate documents before they reach this function.
 */

export const MAX_BATCH_RECORDS = 500;
export const MAX_BATCH_BYTES = 5 * 1024 * 1024;

/** What a format adds to a batch beyond its parts, in UTF-8 bytes. */
export type BatchEnvelope = { fixedBytes: number; separatorBytes: number };

export type BatchLimits = { records: number; bytes: number };

const DEFAULT_LIMITS: BatchLimits = { records: MAX_BATCH_RECORDS, bytes: MAX_BATCH_BYTES };

/**
 * Batches of `parts`, in order, lazily: a batch is yielded as soon as the next
 * part would not fit, so a caller can stop pulling (deadline, abort) without
 * the source being read ahead.
 */
export function* cutBatches(
  parts: Iterable<string>,
  envelope: BatchEnvelope,
  limits: BatchLimits = DEFAULT_LIMITS,
): Generator<string[]> {
  if (!Number.isSafeInteger(limits.records) || limits.records < 1) {
    throw new RangeError("batch record limit must be a positive integer");
  }
  if (!Number.isSafeInteger(limits.bytes) || limits.bytes < 1) {
    throw new RangeError("batch byte limit must be a positive integer");
  }
  let batch: string[] = [];
  let bytes = envelope.fixedBytes;
  for (const part of parts) {
    const size = Buffer.byteLength(part);
    if (batch.length > 0 && bytes + envelope.separatorBytes + size > limits.bytes) {
      yield batch;
      batch = [];
      bytes = envelope.fixedBytes;
    }
    // An empty batch takes the part whatever its size: an oversized one goes alone.
    bytes += (batch.length === 0 ? 0 : envelope.separatorBytes) + size;
    batch.push(part);
    if (batch.length === limits.records) {
      yield batch;
      batch = [];
      bytes = envelope.fixedBytes;
    }
  }
  if (batch.length > 0) yield batch;
}
