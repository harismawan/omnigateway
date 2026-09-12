import { GatewayError } from "@omni/ir";
import type { RequestLog, RequestLogCursor, RequestLogQuery, Store } from "@omni/store";
import { z } from "zod";
import { ALL, readsNothing, type Scope, scopeKey } from "./principal.ts";
import { optionalNumber, parseOrThrow, providerIdSchema } from "./schemas.ts";
import { logLimit } from "./usage.ts";

/**
 * The wire cursor's version.
 *
 * A version rather than a bare pair because the two fields in it are the
 * store's sort key, and a client that has learned to read them has made the
 * SQL ordering a permanent contract. With a version, a later shape is a
 * `BAD_REQUEST` on the old one rather than a silent misparse.
 */
const CURSOR_VERSION = 1;

/** Long enough for any id this gateway mints, short enough to bound a parse. */
const MAX_ID_LENGTH = 128;

/**
 * Bounds on the free-text filters.
 *
 * Model names are client-supplied and unbounded upstream, so the schema is what
 * stops a multi-megabyte query parameter reaching a bound parameter. Nothing
 * here is interpolated into SQL — this is a size limit, not an injection guard.
 */
const MAX_FILTER_LENGTH = 256;

const idSchema = z.string().min(1).max(MAX_ID_LENGTH);
const textSchema = z.string().min(1).max(MAX_FILTER_LENGTH);

/**
 * The filters a caller may send, in the loose shape a query string produces.
 *
 * `.strict()` matters more here than on most of these schemas: a misspelled
 * filter that is merely ignored is a page the operator reads as "no matches"
 * when the truth is "that filter never ran".
 */
const logFilterSchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.union([z.string(), z.number()]).optional(),
    since: z.union([z.string(), z.number()]).optional(),
    until: z.union([z.string(), z.number()]).optional(),
    state: z.enum(["pending", "done"]).optional(),
    failed: z.enum(["true", "false"]).optional(),
    provider: providerIdSchema.optional(),
    requestedModel: textSchema.optional(),
    resolvedModel: textSchema.optional(),
    credentialId: idSchema.optional(),
    apiKeyId: idSchema.optional(),
    errorCode: textSchema.optional(),
  })
  .strict();

export type LogFilterInput = {
  cursor?: string | undefined;
  limit?: string | number | undefined;
  since?: string | number | undefined;
  until?: string | number | undefined;
  state?: string | undefined;
  failed?: string | boolean | undefined;
  provider?: string | undefined;
  requestedModel?: string | undefined;
  resolvedModel?: string | undefined;
  credentialId?: string | undefined;
  apiKeyId?: string | undefined;
  errorCode?: string | undefined;
};

/** Drops keys a caller did not send, so `.strict()` sees absence rather than `undefined`. */
function present(input: LogFilterInput): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === "") continue;
    out[key] = typeof value === "boolean" ? String(value) : value;
  }
  return out;
}

export function encodeLogCursor(cursor: RequestLogCursor): string {
  const json = JSON.stringify({ v: CURSOR_VERSION, at: cursor.at, id: cursor.id });
  return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Reads a wire cursor, or throws.
 *
 * Every failure is `BAD_REQUEST` and none of them falls back to the newest
 * page. A cursor that silently restarts a traversal is the failure mode this
 * whole surface exists to remove: an operator paging through an incident would
 * be handed the head again and read it as having reached the end.
 *
 * The decoded object is checked field by field rather than cast, because it
 * arrives from a client and `JSON.parse` returns `any`-shaped data whatever the
 * annotation says.
 */
export function decodeLogCursor(raw: string): RequestLogCursor {
  const reject = (): never => {
    throw new GatewayError("BAD_REQUEST", "cursor: malformed");
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return reject();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return reject();
  const record = parsed as Record<string, unknown>;
  // Extra keys are a reject rather than an ignore, for the same reason the
  // filter schema is strict: an unknown field means this value was not produced
  // by this version, and guessing at it is how a future shape gets misread.
  const keys = Object.keys(record);
  if (keys.length !== 3) return reject();
  if (record.v !== CURSOR_VERSION) {
    throw new GatewayError("BAD_REQUEST", "cursor: unknown version");
  }
  const { at, id } = record;
  if (typeof at !== "number" || !Number.isSafeInteger(at)) return reject();
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) return reject();
  return { at, id };
}

/**
 * Turns caller input and a verified scope into a store query.
 *
 * The scope is a separate argument from the filters, and that separation is the
 * whole security property: the filters are caller-supplied and can only ever
 * narrow, while the key restriction comes from the session. The scope's key is
 * written **after** the caller's `apiKeyId`, so a client sending one cannot
 * widen past its own — and the client route does not accept the parameter at
 * all, so this is the second of two gates rather than the only one.
 */
function toQuery(input: LogFilterInput, scope: Scope): RequestLogQuery {
  const filters = parseOrThrow(logFilterSchema, present(input));

  const since = filters.since === undefined ? undefined : optionalNumber(filters.since, 0);
  const until = filters.until === undefined ? undefined : optionalNumber(filters.until, 0);
  if (since !== undefined && until !== undefined && since > until) {
    throw new GatewayError("BAD_REQUEST", "since: must not be after until");
  }

  const scoped = scopeKey(scope);
  return {
    limit: logLimit(filters.limit),
    cursor: filters.cursor === undefined ? null : decodeLogCursor(filters.cursor),
    ...(filters.apiKeyId === undefined ? {} : { apiKeyId: filters.apiKeyId }),
    ...(scoped === undefined ? {} : { apiKeyId: scoped }),
    ...(filters.credentialId === undefined ? {} : { credentialId: filters.credentialId }),
    ...(filters.provider === undefined ? {} : { provider: filters.provider }),
    ...(filters.requestedModel === undefined ? {} : { requestedModel: filters.requestedModel }),
    ...(filters.resolvedModel === undefined ? {} : { resolvedModel: filters.resolvedModel }),
    ...(filters.errorCode === undefined ? {} : { errorCode: filters.errorCode }),
    ...(filters.state === undefined ? {} : { state: filters.state }),
    // `false` is dropped, never passed through. "Not failed" and "succeeded"
    // differ on every pending row, and only one of them is a question the
    // console's badge can answer.
    ...(filters.failed === "true" ? { failed: true } : {}),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
  };
}

/** A page of rows and the opaque cursor that continues it. */
export type LogPage = { logs: RequestLog[]; nextCursor: string | null };

/**
 * One filtered page of request logs, narrowed to what the scope may read.
 *
 * Same order as `recentLogs` and for the same reason: `readsNothing` before
 * `scopeKey`, because `scopeKey` collapses `all` and `none` to the same
 * `undefined` and one of them means every row.
 */
export async function pageLogs(
  store: Store,
  input: LogFilterInput = {},
  scope: Scope = ALL,
): Promise<LogPage> {
  // Parsed even when the scope reads nothing, so a client sending a malformed
  // cursor gets the same `BAD_REQUEST` an operator would rather than an empty
  // page that looks like the end of its history.
  const query = toQuery(input, scope);
  if (readsNothing(scope)) return { logs: [], nextCursor: null };
  const page = await store.usage.page(query);
  return {
    logs: page.logs,
    nextCursor: page.next === null ? null : encodeLogCursor(page.next),
  };
}

/** How many rows an export pulls per store read. Not the caller's page size. */
const EXPORT_BATCH = 500;

export type LogExportFormat = "csv" | "jsonl";

/**
 * Every column an export writes, in order.
 *
 * Written out rather than derived from a row, because a row is the wrong source
 * for a *stable* column order: a log with a null tail would produce a different
 * header from one without, and `Object.keys` on the first row makes the shape of
 * the export depend on which request happened to be newest. Deriving it from
 * `RequestLog` also means a column added to that type appears in operators'
 * spreadsheets without anybody deciding it should.
 *
 * The compiler still holds the two together: the tuple is typed as keys of
 * `RequestLog`, so a renamed field is an error here rather than an empty column.
 */
const EXPORT_COLUMNS: ReadonlyArray<keyof RequestLog> = [
  "id",
  "state",
  "at",
  "apiKeyId",
  "requestedModel",
  "resolvedProvider",
  "resolvedModel",
  "credentialId",
  "attempts",
  "status",
  "errorCode",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "ttftMs",
  "durationMs",
  "costUsd",
  "degradations",
  "rtkApplied",
  "rtkFilterHits",
  "rtkOriginalCodeUnits",
  "rtkCompressedCodeUnits",
  "rtkEstimatedTokensSaved",
  "rtkFilters",
];

/**
 * One CSV cell.
 *
 * The leading apostrophe on `=`, `+`, `-` and `@` is formula neutralisation:
 * a spreadsheet reading `=1+cmd|'/c calc'!A1` out of an unquoted cell executes
 * it, and a request log carries client-supplied model names and upstream error
 * text. It is applied after leading whitespace because that is what the
 * spreadsheets skip too.
 *
 * This makes CSV deliberately not byte-exact for such text. JSONL is the
 * lossless format, and that split is the reason both exist rather than one.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? JSON.stringify(value) : String(value);
  const first = text.trimStart().charAt(0);
  const guarded = "=+-@".includes(first) && first !== "" ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

const csvRow = (cells: readonly unknown[]): string =>
  `${cells.map(csvCell).join(",")}\r\n`; /* RFC 4180 line ending. */

/** The first bytes of an export, before any row is read. */
export function exportHeader(format: LogExportFormat): string {
  return format === "csv" ? csvRow(EXPORT_COLUMNS) : "";
}

/** One row, encoded. Both formats terminate every row, the last one included. */
export function exportRow(format: LogExportFormat, log: RequestLog): string {
  if (format === "jsonl") {
    // Rebuilt in `EXPORT_COLUMNS` order rather than serialized as it arrived:
    // key order in JSONL is part of what makes two exports diffable, and a
    // store's row-mapper is free to build its object in any order.
    const ordered: Record<string, unknown> = {};
    for (const column of EXPORT_COLUMNS) ordered[column] = log[column];
    return `${JSON.stringify(ordered)}\n`;
  }
  return csvRow(EXPORT_COLUMNS.map((column) => log[column]));
}

export const EXPORT_CONTENT_TYPE: Readonly<Record<LogExportFormat, string>> = {
  csv: "text/csv; charset=utf-8",
  jsonl: "application/x-ndjson",
};

/** A server-chosen name, so no caller-supplied text reaches a download header. */
export function exportFilename(format: LogExportFormat, now: number): string {
  const stamp = new Date(now).toISOString().replaceAll(/[:.]/g, "-");
  return `omnigateway-logs-${stamp}.${format}`;
}

export type LogExportInput = LogFilterInput & { format?: string | undefined };

const formatSchema = z.enum(["csv", "jsonl"]);

/**
 * Streams every matching retained row, oldest page last, as CSV or JSONL.
 *
 * A generator rather than a returned string: an unbounded interval over a busy
 * gateway is more rows than a process should hold, and the caller — an HTTP
 * response or a CLI writing stdout — can apply backpressure to a generator for
 * free. A consumer that stops iterating stops the paging, which is how
 * cancellation is handled without a second mechanism.
 *
 * Both time bounds are required. Export is the one read here with no page size
 * to bound it, so the interval is what bounds it instead; an export with no
 * range is a request for the entire retention window and nobody who typed it
 * meant that. There is deliberately no silent row cap — a truncated CSV that
 * looks complete is worse than a refusal, so if volume later needs a ceiling it
 * belongs in a pre-stream rejection, not in the loop.
 *
 * A store failure mid-stream propagates and the response dies with it. Nothing
 * writes an in-band error or truncation row: both formats would parse it as
 * data.
 */
export async function* exportLogs(
  store: Store,
  input: LogExportInput,
  scope: Scope = ALL,
): AsyncGenerator<string> {
  // Split off before anything else: `format` names the encoding, not a filter,
  // and the filter schema is strict — passing the whole input through would
  // make every export that named a format a `BAD_REQUEST`.
  const { format: requested, ...filters } = input;
  const format = parseOrThrow(formatSchema, requested ?? "csv");
  if (input.since === undefined || input.since === "") {
    throw new GatewayError("BAD_REQUEST", "since: required for export");
  }
  if (input.until === undefined || input.until === "") {
    throw new GatewayError("BAD_REQUEST", "until: required for export");
  }

  // Through the same normalization and the same scope gate as an interactive
  // page, so there is no second definition of what a filter means or of who may
  // read what. `limit` is this function's own: the caller's page size describes
  // a screenful and has nothing to do with how the walk is batched.
  const base = toQuery({ ...filters, limit: EXPORT_BATCH, cursor: undefined }, scope);

  yield exportHeader(format);
  if (readsNothing(scope)) return;

  let cursor = base.cursor;
  for (;;) {
    const page = await store.usage.page({ ...base, cursor });
    for (const log of page.logs) yield exportRow(format, log);
    if (page.next === null) return;
    cursor = page.next;
  }
}
