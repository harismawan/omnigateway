import {
  EXPORT_DESTINATION_TYPES,
  type ExportDestination,
  type ExportDestinationType,
  type ExportFilter,
} from "./types.ts";

/**
 * The columns every destination read selects: everything but the secret, which
 * is reduced to whether one is set. Never `SELECT *`, so the ciphertext does not
 * even reach a reader that would only have to remember to drop it.
 */
export const DESTINATION_COLUMNS = `id, generation, type, enabled, config, filter, include_bodies,
  max_request_bytes, start_at, created_at, updated_at, secret IS NOT NULL AS has_secret`;

/** A destination row as either driver returns it: SQLite 0/1 and numbers, Postgres booleans and BIGINT strings. */
export type DestinationRow = {
  id: string;
  generation: string;
  type: string;
  enabled: number | boolean;
  config: string;
  filter: string;
  include_bodies: number | boolean;
  max_request_bytes: number | string | null;
  start_at: number | string;
  created_at: number | string;
  updated_at: number | string;
  has_secret: number | boolean;
};

const isType = (value: string): value is ExportDestinationType =>
  (EXPORT_DESTINATION_TYPES as readonly string[]).includes(value);

/** A stored JSON object, or null when the text is not one. */
function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `config` is type-specific and validated above the store; unreadable reads as empty. */
const parseConfig = (raw: string): Record<string, unknown> => parseObject(raw) ?? {};

/**
 * Selects no row whatever it is combined with: an empty key set.
 *
 * What an unreadable stored filter reads as. A filter is the scope of what
 * leaves the installation, so every way of misreading one must narrow — never
 * widen — and dropping a field that failed to parse would be a widening:
 * `{"apiKeyIds":"k1"}` read as "no key filter" ships every key's traffic.
 *
 * A fresh object per call, not a shared constant: a caller owns the filter it
 * is handed, and one array shared across reads, pushed into once, would widen
 * every later malformed destination's scope. (`Object.freeze` is shallow.)
 */
export const matchNothing = (): ExportFilter => ({ apiKeyIds: [] });

const FILTER_FIELDS = new Set(["apiKeyIds", "models", "failedOnly"]);

const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/**
 * The stored filter exactly as written, or null when any part of it cannot be
 * read: not a JSON object, a list that is not all strings, a `failedOnly` that
 * is not a boolean, or a field this build does not know (which a newer build
 * may have meant as a restriction). Absent fields are absent; nothing is
 * dropped or coerced, because both are ways of widening a scope.
 */
function parseFilter(raw: string): ExportFilter | null {
  const stored = parseObject(raw);
  if (stored === null) return null;
  if (Object.keys(stored).some((key) => !FILTER_FIELDS.has(key))) return null;
  const { apiKeyIds, models, failedOnly } = stored;
  if (apiKeyIds !== undefined && !stringList(apiKeyIds)) return null;
  if (models !== undefined && !stringList(models)) return null;
  if (failedOnly !== undefined && typeof failedOnly !== "boolean") return null;
  return {
    ...(apiKeyIds === undefined ? {} : { apiKeyIds }),
    ...(models === undefined ? {} : { models }),
    ...(failedOnly === undefined ? {} : { failedOnly }),
  };
}

const flag = (value: number | boolean): boolean => value === true || value === 1;

/**
 * Null for a row whose `type` no build knows, so a reader skips it rather than
 * handing the worker an encoder it does not have.
 */
export function readDestination(r: DestinationRow): ExportDestination | null {
  if (!isType(r.type)) return null;
  const filter = parseFilter(r.filter);
  return {
    id: r.id,
    generation: r.generation,
    type: r.type,
    enabled: flag(r.enabled),
    config: parseConfig(r.config),
    filter: filter ?? matchNothing(),
    filterMalformed: filter === null,
    includeBodies: flag(r.include_bodies),
    maxRequestBytes: r.max_request_bytes === null ? null : Number(r.max_request_bytes),
    startAt: Number(r.start_at),
    hasSecret: flag(r.has_secret),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
