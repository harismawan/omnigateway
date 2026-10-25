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

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;

function parseObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The stored filter, narrowed. A malformed list member is dropped rather than
 * passed through, so a hand-edited row can narrow a filter but never turn it
 * into something the SQL builder cannot bind.
 */
function parseFilter(raw: string): ExportFilter {
  const stored = parseObject(raw);
  const apiKeyIds = strings(stored.apiKeyIds);
  const models = strings(stored.models);
  return {
    ...(apiKeyIds === undefined ? {} : { apiKeyIds }),
    ...(models === undefined ? {} : { models }),
    ...(stored.failedOnly === true ? { failedOnly: true } : {}),
  };
}

const flag = (value: number | boolean): boolean => value === true || value === 1;

/**
 * Null for a row whose `type` no build knows, so a reader skips it rather than
 * handing the worker an encoder it does not have.
 */
export function readDestination(r: DestinationRow): ExportDestination | null {
  if (!isType(r.type)) return null;
  return {
    id: r.id,
    generation: r.generation,
    type: r.type,
    enabled: flag(r.enabled),
    config: parseObject(r.config),
    filter: parseFilter(r.filter),
    includeBodies: flag(r.include_bodies),
    maxRequestBytes: r.max_request_bytes === null ? null : Number(r.max_request_bytes),
    startAt: Number(r.start_at),
    hasSecret: flag(r.has_secret),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
