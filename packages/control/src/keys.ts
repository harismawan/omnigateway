import { GatewayError } from "@omni/ir";
import {
  type Dimension,
  type LimitConfig,
  WINDOW_MS,
  WINDOWS,
  type Window,
} from "@omni/ratelimit/catalog";
import type { ApiKey, Store, UsageSums } from "@omni/store";
import { generateApiKey, hashApiKey } from "@omni/store";
import { keyCreateSchema, keyLimitsSchema, keyModelsSchema, parseOrThrow } from "./schemas.ts";

/**
 * One configured ceiling and what the stored history says has gone against it.
 *
 * `used` is committed usage only. `request_logs` holds completed requests, so
 * this is the same body of evidence the gateway's own long windows are built
 * from — but not the same number: the gateway adds an in-memory delta for
 * everything since its last read, and that delta lives in the serving process.
 * A reading is therefore a floor on what the limiter sees, never above it.
 */
export type LimitReading = {
  dimension: Dimension;
  /** Null for `concurrency`, which is a gauge and has no window. */
  window: Window | null;
  limit: number;
  /**
   * Null where the stored history cannot answer, which today means
   * `concurrency` alone: in-flight requests are a gauge held in the gateway
   * process and no row records one. Reporting zero would tell an operator
   * running the CLI beside a busy gateway that every key is idle.
   */
  used: number | null;
};

/** Everything about a key except the material needed to use it. */
export type ApiKeySummary = Omit<ApiKey, "hash"> & {
  /**
   * One entry per configured limit, so a reader can render the matrix without
   * knowing which pairs are meaningful. Empty for an unlimited key, and empty
   * for one whose stored matrix could not be parsed — there is nothing to
   * measure against a ceiling nobody can read.
   */
  limitUsage: LimitReading[];
};

/** The windows any dimension of this matrix is counted over. */
function configuredWindows(limits: LimitConfig): Window[] {
  const needed = new Set<Window>();
  for (const dimension of ["requests", "tokens", "spend"] as const) {
    const windows: Partial<Record<Window, number | null | undefined>> | undefined =
      limits[dimension];
    if (windows === undefined) continue;
    for (const window of WINDOWS) {
      const limit = windows[window];
      if (limit !== undefined && limit !== null) needed.add(window);
    }
  }
  return [...needed];
}

/**
 * Reads what one key has spent against each of its ceilings.
 *
 * One `sumSince` per distinct window rather than per pair: the sum answers all
 * three windowed dimensions at once, and a key with a full matrix is three
 * queries rather than eight. A key with no limits is none.
 */
async function readLimitUsage(
  store: Store,
  id: string,
  limits: LimitConfig | null,
  now: number,
): Promise<LimitReading[]> {
  if (limits === null) return [];

  const sums = new Map<Window, UsageSums>();
  for (const window of configuredWindows(limits)) {
    sums.set(window, await store.usage.sumSince(id, now - WINDOW_MS[window]));
  }

  const readings: LimitReading[] = [];
  for (const dimension of ["requests", "tokens", "spend"] as const) {
    const windows: Partial<Record<Window, number | null | undefined>> | undefined =
      limits[dimension];
    if (windows === undefined) continue;
    for (const window of WINDOWS) {
      const limit = windows[window];
      if (limit === undefined || limit === null) continue;
      const sum = sums.get(window);
      const used =
        sum === undefined
          ? null
          : dimension === "requests"
            ? sum.requests
            : dimension === "tokens"
              ? sum.tokens
              : sum.costUsd;
      readings.push({ dimension, window, limit, used });
    }
  }

  if (limits.concurrency !== undefined && limits.concurrency !== null) {
    readings.push({
      dimension: "concurrency",
      window: null,
      limit: limits.concurrency,
      used: null,
    });
  }
  return readings;
}

async function toSummary(store: Store, key: ApiKey, now: number): Promise<ApiKeySummary> {
  return {
    id: key.id,
    label: key.label,
    // The display prefix, never the key. `hash` is deliberately absent:
    // it is not a secret, but publishing it invites offline guessing.
    prefix: key.prefix,
    modelAllowlist: key.modelAllowlist,
    // Carried through as-is, `null` included. A key whose stored limits cannot
    // be parsed is refused at `/v1`, so the listing is the only place an
    // operator can see which key that is — flattening it to `{}` here would
    // show them an unlimited key and hide the one thing worth acting on.
    limits: key.limits,
    limitUsage: await readLimitUsage(store, key.id, key.limits, now),
    // Not a secret and not a policy the gateway hides: an operator auditing a
    // shared installation has to be able to see which client's payloads are
    // exempt from capture without reading the database.
    bodyLoggingOptOut: key.bodyLoggingOptOut,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt,
  };
}

export async function listKeys(store: Store, now: number = Date.now()): Promise<ApiKeySummary[]> {
  // The store never holds the raw key, only its hash, so there is nothing
  // to strip here — but the shape is explicit for the same reason.
  const keys = await store.keys.list();
  return Promise.all(keys.map((key) => toSummary(store, key, now)));
}

/**
 * One key as its own holder sees it.
 *
 * Deliberately the same `ApiKeySummary` the operator's listing is built from,
 * produced by the same `toSummary`. A second, narrower shape for the client
 * would be a second answer to "what is safe to show about a key", and the two
 * would drift — the summary already excludes `hash` because that question was
 * settled once, here.
 *
 * `bodyLoggingOptOut` is included and is the point: it is a promise made to
 * whoever holds this key, and the holder is exactly who should be able to
 * check it.
 */
export async function readOwnKey(
  store: Store,
  apiKeyId: string,
  now: number = Date.now(),
): Promise<ApiKeySummary> {
  const key = await store.keys.get(apiKeyId);
  // A live session whose key vanished. Refused rather than reported empty: an
  // empty summary reads as "a key with no limits", which is the opposite of
  // what a missing key means.
  if (key === null) throw new GatewayError("AUTH", "no such api key");
  return toSummary(store, key, now);
}

export type CreatedKey = { id: string; label: string; prefix: string; key: string };

/**
 * Mints a gateway API key.
 *
 * The returned `key` is the only time the raw value exists outside the caller's
 * hands: it is stored as a hash, so an operator who loses it must issue a new one.
 */
export async function createKey(store: Store, input: unknown): Promise<CreatedKey> {
  const body = parseOrThrow(keyCreateSchema, input);

  const raw = generateApiKey();
  const created = await store.keys.create({
    id: crypto.randomUUID(),
    label: body.label,
    prefix: raw.slice(0, 12),
    hash: await hashApiKey(raw),
    modelAllowlist: body.modelAllowlist,
    limits: body.limits,
    // Settable only at creation. A key handed to a client on the promise that
    // its payloads are never retained must not become capturable later by an
    // edit the client cannot see, and there is no patch route to make one.
    bodyLoggingOptOut: body.bodyLoggingOptOut,
  });

  return { id: created.id, label: created.label, prefix: created.prefix, key: raw };
}

/**
 * Replaces one key's limits and reports the key as it now stands.
 *
 * The matrix arrives whole, validated by the same strict schema that guards
 * minting — so an unknown dimension or window name is refused at this boundary
 * rather than stored and later read as no limit at all. An empty matrix is a
 * legitimate value and leaves the key unlimited, which is how the last limit is
 * removed.
 */
export async function setKeyLimits(
  store: Store,
  id: string,
  input: unknown,
  now: number = Date.now(),
): Promise<ApiKeySummary> {
  const body = parseOrThrow(keyLimitsSchema, input);

  // Looked up before the write so an unknown id is refused rather than becoming
  // an UPDATE that matches no row and reports success. `get`, not `list`: the
  // latter parses every key on a synchronous database to look at one.
  const key = await store.keys.get(id);
  if (key === null) throw new GatewayError("BAD_REQUEST", "no such api key");

  await store.keys.setLimits(id, body.limits);
  return toSummary(store, { ...key, limits: body.limits }, now);
}

/**
 * Replaces one key's model allowlist and reports the key as it now stands.
 *
 * The list arrives whole, so `null` (every model) and `[]` (none) are
 * expressible as themselves. An unknown id is refused before the write for
 * the same reason `setKeyLimits` refuses one — an UPDATE that matches no row
 * must not report success.
 */
export async function setKeyModels(
  store: Store,
  id: string,
  input: unknown,
  now: number = Date.now(),
): Promise<ApiKeySummary> {
  const body = parseOrThrow(keyModelsSchema, input);

  const key = await store.keys.get(id);
  if (key === null) throw new GatewayError("BAD_REQUEST", "no such api key");

  await store.keys.setModelAllowlist(id, body.modelAllowlist);
  return toSummary(store, { ...key, modelAllowlist: body.modelAllowlist }, now);
}

export async function revokeKey(store: Store, id: string): Promise<void> {
  // Revoke, not delete. The usage rows reference this id, and a report that
  // silently loses its attribution is worse than one naming a dead key.
  await store.keys.revoke(id);
}
