/**
 * Cutting encoded records into request-sized batches. Pure.
 *
 * Design caps (*Delivery*, Batch): at most 500 records and 5 MiB encoded,
 * whichever comes first, and **no yielded batch ever exceeds either**. Bytes
 * are UTF-8 and include the destination format's envelope — the fixed text
 * around the records and the separator between two — which each encoder
 * declares as a {@link BatchEnvelope}. Compression is not counted: the cap
 * bounds what is built in memory, and gzip only shrinks it.
 *
 * A record whose part cannot fit even alone (part + envelope over the byte
 * cap) is neither batched nor silently skipped: it is yielded in place as an
 * `oversized` cut with the fixed reason {@link OVERSIZED_REASON}, for the
 * caller to count as dropped. Order is preserved, so the cursor can move past
 * it with the batch that follows. A metadata record is a few KiB at most
 * (every free-text field is bounded at ingress), so this cannot realistically
 * happen in part 1; body export (part 2) segments large bodies into separate
 * documents before they reach this function.
 */

export const MAX_BATCH_RECORDS = 500;
export const MAX_BATCH_BYTES = 5 * 1024 * 1024;

/** Gateway-authored, fixed: safe for `last_error` and counters. */
export const OVERSIZED_REASON = "record-too-large";

/** What a format adds to a batch beyond its parts, in UTF-8 bytes. */
export type BatchEnvelope = { fixedBytes: number; separatorBytes: number };

/** Tighter caps for one destination; never above the design caps. */
export type BatchLimits = { records: number; bytes: number };

/**
 * One step of the cut, in input order. `start` and `index` are positions in
 * the input sequence, so the caller maps a cut back to its rows.
 */
export type BatchCut =
  | { kind: "batch"; start: number; parts: string[] }
  | { kind: "oversized"; index: number; bytes: number; reason: typeof OVERSIZED_REASON };

const DEFAULT_LIMITS: BatchLimits = { records: MAX_BATCH_RECORDS, bytes: MAX_BATCH_BYTES };

function check(value: number, max: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`batch ${what} limit must be a positive integer`);
  }
  if (value > max) throw new RangeError(`batch ${what} limit cannot exceed ${max}`);
}

function checkEnvelope(envelope: BatchEnvelope): void {
  for (const value of [envelope.fixedBytes, envelope.separatorBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("batch envelope sizes must be whole non-negative bytes");
    }
  }
}

/**
 * Cuts of `parts`, in order, lazily: a batch is yielded as soon as the next
 * part would not fit, so a caller can stop pulling (deadline, abort) without
 * the source being read ahead.
 */
export function* cutBatches(
  parts: Iterable<string>,
  envelope: BatchEnvelope,
  limits: BatchLimits = DEFAULT_LIMITS,
): Generator<BatchCut> {
  check(limits.records, MAX_BATCH_RECORDS, "record");
  check(limits.bytes, MAX_BATCH_BYTES, "byte");
  checkEnvelope(envelope);
  let batch: string[] = [];
  let start = 0;
  let bytes = envelope.fixedBytes;
  let index = 0;
  for (const part of parts) {
    const at = index++;
    const size = Buffer.byteLength(part);
    if (envelope.fixedBytes + size > limits.bytes) {
      if (batch.length > 0) yield { kind: "batch", start, parts: batch };
      batch = [];
      bytes = envelope.fixedBytes;
      yield { kind: "oversized", index: at, bytes: size, reason: OVERSIZED_REASON };
      continue;
    }
    if (batch.length > 0 && bytes + envelope.separatorBytes + size > limits.bytes) {
      yield { kind: "batch", start, parts: batch };
      batch = [];
      bytes = envelope.fixedBytes;
    }
    if (batch.length === 0) start = at;
    bytes += (batch.length === 0 ? 0 : envelope.separatorBytes) + size;
    batch.push(part);
    if (batch.length === limits.records) {
      yield { kind: "batch", start, parts: batch };
      batch = [];
      bytes = envelope.fixedBytes;
    }
  }
  if (batch.length > 0) yield { kind: "batch", start, parts: batch };
}
