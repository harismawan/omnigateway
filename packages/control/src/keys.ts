import type { ApiKey, Store } from "@omni/store";
import { generateApiKey, hashApiKey } from "@omni/store";
import { keyCreateSchema, parseOrThrow } from "./schemas.ts";

/** Everything about a key except the material needed to use it. */
export type ApiKeySummary = Omit<ApiKey, "hash">;

export async function listKeys(store: Store): Promise<ApiKeySummary[]> {
  // The store never holds the raw key, only its hash, so there is nothing
  // to strip here — but the shape is explicit for the same reason.
  const keys = await store.keys.list();
  return keys.map((k) => ({
    id: k.id,
    label: k.label,
    // The display prefix, never the key. `hash` is deliberately absent:
    // it is not a secret, but publishing it invites offline guessing.
    prefix: k.prefix,
    modelAllowlist: k.modelAllowlist,
    rateLimitPerMin: k.rateLimitPerMin,
    createdAt: k.createdAt,
    revokedAt: k.revokedAt,
  }));
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
    rateLimitPerMin: body.rateLimitPerMin,
  });

  return { id: created.id, label: created.label, prefix: created.prefix, key: raw };
}

export async function revokeKey(store: Store, id: string): Promise<void> {
  // Revoke, not delete. The usage rows reference this id, and a report that
  // silently loses its attribution is worse than one naming a dead key.
  await store.keys.revoke(id);
}
