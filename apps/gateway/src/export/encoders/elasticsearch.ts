import type { BatchEnvelope } from "../batch.ts";
import type { RequestRecord } from "../record.ts";

/**
 * Elasticsearch / OpenSearch `_bulk` encoding, and reading its response.
 *
 * Every document is an `index` action whose `_id` is the request id, so a
 * resend overwrites rather than duplicates. Pure: no I/O, no clock — the index
 * date comes from the record's own `at`.
 */

export const DEFAULT_INDEX_PATTERN = "omni-logs-{yyyy.MM.dd}";

/** Both flavours take NDJSON under this type. */
export const BULK_CONTENT_TYPE = "application/x-ndjson";

/** `_bulk` has no envelope: the body is the parts concatenated, each ending in `\n`. */
export const BULK_ENVELOPE: BatchEnvelope = { fixedBytes: 0, separatorBytes: 0 };

export type BulkOptions = { indexPattern: string };

const DATE_TOKEN = "{yyyy.MM.dd}";
const MAX_INDEX_BYTES = 255;
const FORBIDDEN = /[\\/*?"<>| ,#:]/;

/**
 * Why Elasticsearch would refuse this index name, or `null` when it would not.
 *
 * Checked before sending because a refused index comes back as a per-item 400
 * on every document — which the bulk reader rightly reads as "drop these" — so
 * a bad pattern would silently discard everything the destination sends.
 */
export function indexNameProblem(name: string): string | null {
  if (name.length === 0) return "index name is empty";
  if (name !== name.toLowerCase()) return "index name must be lowercase";
  if (name === "." || name === "..") return "index name cannot be . or ..";
  if (/^[-_+]/.test(name)) return "index name cannot start with -, _ or +";
  if (FORBIDDEN.test(name)) return 'index name cannot contain \\ / * ? " < > | space , # or :';
  if (Buffer.byteLength(name) > MAX_INDEX_BYTES) return "index name is longer than 255 bytes";
  return null;
}

/**
 * The index for a document started at `at` (epoch ms): every `{yyyy.MM.dd}` in
 * the pattern becomes that UTC day, everything else is kept verbatim. Throws
 * when the result is not a name Elasticsearch accepts.
 *
 * The thrown message quotes the operator-configured name, for a test or an
 * admin-facing validation error. This module logs nothing; a caller that logs
 * must log a fixed summary, never this message.
 */
export function indexName(pattern: string, at: number): string {
  const day = new Date(at);
  const date = [
    String(day.getUTCFullYear()).padStart(4, "0"),
    String(day.getUTCMonth() + 1).padStart(2, "0"),
    String(day.getUTCDate()).padStart(2, "0"),
  ].join(".");
  const name = pattern.replaceAll(DATE_TOKEN, date);
  const problem = indexNameProblem(name);
  if (problem !== null) throw new RangeError(`${problem}: ${JSON.stringify(name)}`);
  return name;
}

/** One document's action and source lines, newline-terminated. */
export function bulkPart(record: RequestRecord, opts: BulkOptions): string {
  const action = {
    index: { _index: indexName(opts.indexPattern, Date.parse(record.at)), _id: record.id },
  };
  return `${JSON.stringify(action)}\n${JSON.stringify(record)}\n`;
}

export function encodeBulk(records: readonly RequestRecord[], opts: BulkOptions): string {
  return records.map((record) => bulkPart(record, opts)).join("");
}

export type BulkDropped = { id: string | null; status: number; reason: string };

/**
 * What a `_bulk` reply means for the batch:
 * - `retry` — the whole batch is resent later and the cursor does not move: a
 *   retryable HTTP status, or any item at 429 / 5xx;
 * - otherwise, if `failure` is set, the batch is a hard failure (a non-2xx the
 *   worker does not retry, or a 2xx it cannot read — never a silent commit);
 * - otherwise the batch commits, with `dropped` naming items the receiver
 *   refused for good (mapping conflicts and the like).
 *
 * Reasons are the receiver's `error.type` only, and only when it is a plain
 * identifier. Its `reason` text is never read: it can echo document content.
 */
export type BulkOutcome = {
  retry: boolean;
  dropped: BulkDropped[];
  failure: { status: number; reason: string } | null;
};

const UNKNOWN = "unknown";
const UNREADABLE = "unreadable-bulk-response";
const ERROR_TYPE = /^[A-Za-z0-9_.]{1,64}$/;
const MAX_ID = 256;

export function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function readBulkResponse(json: unknown, httpStatus: number): BulkOutcome {
  if (retryableStatus(httpStatus)) return { retry: true, dropped: [], failure: null };
  if (httpStatus < 200 || httpStatus > 299) {
    const reason = isRecord(json) ? errorType(json.error) : UNKNOWN;
    return { retry: false, dropped: [], failure: { status: httpStatus, reason } };
  }
  const unreadable: BulkOutcome = {
    retry: false,
    dropped: [],
    failure: { status: httpStatus, reason: UNREADABLE },
  };
  if (!isRecord(json)) return unreadable;
  if (json.errors === false) return { retry: false, dropped: [], failure: null };
  if (json.errors !== true || !Array.isArray(json.items)) return unreadable;

  const dropped: BulkDropped[] = [];
  let retry = false;
  for (const item of json.items) {
    // We send `index` actions only, so that is the only result we accept.
    const result = isRecord(item) ? item.index : undefined;
    const status = isRecord(result) ? result.status : undefined;
    if (!isRecord(result) || typeof status !== "number" || !Number.isInteger(status)) {
      return unreadable;
    }
    if (status >= 200 && status <= 299) continue;
    if (status === 429 || status >= 500) {
      retry = true;
      continue;
    }
    const id = typeof result._id === "string" && result._id.length <= MAX_ID ? result._id : null;
    dropped.push({ id, status, reason: errorType(result.error) });
  }
  return retry
    ? { retry: true, dropped: [], failure: null }
    : { retry: false, dropped, failure: null };
}

function errorType(error: unknown): string {
  if (!isRecord(error) || typeof error.type !== "string") return UNKNOWN;
  return ERROR_TYPE.test(error.type) ? error.type : UNKNOWN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
