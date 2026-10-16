import { createHash, createHmac } from "node:crypto";

/**
 * The identifiers Codex mints, derived instead of minted.
 *
 * Codex holds state — a thread id from thread start, an installation id on
 * disk, ids on every history item — and this gateway holds none. Every value
 * here is therefore a function of something the request already carries, which
 * is what keeps `buildRequest` a pure function of its input: failover and the
 * AUTH retry rebuild the same bytes. What each derives from, and why that is
 * enough, is in the Codex 0.163 fingerprint spec.
 *
 * Hashed throughout, never forwarded: the inputs include `conversationId`
 * (Claude Code's carries an account uuid) and the ChatGPT account id, neither of
 * which the operator chose to disclose in a new field.
 */

/** RFC 4122 `NAMESPACE_OID`, which Codex roots its per-thread namespace in. */
const NAMESPACE_OID = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a derived UUIDv7's timestamp may fall: a year ending 2026-10-01.
 *
 * A Codex thread id is a v7 minted at thread start, so its first 48 bits are a
 * past instant. A derived one has no start to read, and must be stable across a
 * conversation's turns, so its instant is drawn from a fixed window instead —
 * entirely in the past, so the field is never a future time whatever day the
 * request is sent.
 */
const WINDOW_END_MS = Date.UTC(2026, 9, 1);
const WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

function format(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function withVersion(bytes: Uint8Array, version: number): Uint8Array {
  const out = Uint8Array.from(bytes.subarray(0, 16));
  out[6] = ((out[6] ?? 0) & 0x0f) | (version << 4);
  out[8] = ((out[8] ?? 0) & 0x3f) | 0x80;
  return out;
}

const sha256 = (seed: string): Buffer => createHash("sha256").update(seed).digest();

/** RFC 4122 UUIDv5, as Rust's `Uuid::new_v5`. */
export function uuidV5(namespace: string, name: string): string {
  const digest = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(name, "utf8")
    .digest();
  return format(withVersion(digest, 5));
}

/** A UUIDv4-shaped digest of `seed`: the shape of Codex's installation id. */
export function uuidV4From(seed: string): string {
  return format(withVersion(sha256(seed), 4));
}

/**
 * A UUIDv7-shaped id: `timestampMs` in the first 48 bits, the rest from a
 * digest of `seed`. The shape of Codex's thread, turn and history-item ids.
 */
export function uuidV7From(seed: string, timestampMs: number): string {
  const bytes = Uint8Array.from(sha256(seed).subarray(0, 16));
  let ts = Math.max(0, Math.floor(timestampMs));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  return format(withVersion(bytes, 7));
}

/**
 * A thread id for a conversation, from the string that identifies it.
 *
 * A UUIDv7 whose instant is drawn from `seed` into the past window, so the same
 * conversation always maps to the same id and no id claims a future time.
 */
export function threadIdFrom(seed: string): string {
  const digest = sha256(`thread:${seed}`);
  const offset = digest.readUIntBE(0, 6) % WINDOW_MS;
  return uuidV7From(seed, WINDOW_END_MS - WINDOW_MS + offset);
}

/**
 * The instant a thread id names, for ids minted "after" it.
 *
 * A v7 at or before now is a real client's thread (Codex's own, passed through)
 * and is used as is. Anything else — a v4 a client chose, a v7 claiming the
 * future — has no meaningful instant, so one is derived the way
 * `threadIdFrom` derives it.
 */
export function threadInstant(threadId: string, now: number): number {
  const hex = threadId.replace(/-/g, "");
  const version = hex[12];
  const ts = Number.parseInt(hex.slice(0, 12), 16);
  if (version === "7" && Number.isFinite(ts) && ts <= now) return ts;
  const digest = sha256(`thread:${threadId}`);
  return WINDOW_END_MS - WINDOW_MS + (digest.readUIntBE(0, 6) % WINDOW_MS);
}

const ID_SALT = /^[0-9a-f]{64}$/;

/**
 * The two per-credential values the fingerprint keeps in `providerData`.
 *
 * `installationId` is what Codex keeps in `$CODEX_HOME/installation_id`: a
 * random UUIDv4 minted once. `idSalt` keys every id this module derives, so
 * none of them can be recomputed from what the request itself carries —
 * unkeyed, a `turn_id` was a hash of the `thread_id` beside it, and the
 * installation id a hash of the account id in the next header. Minted at
 * connect by the OpenAI OAuth flow and backfilled by its refresh; a credential
 * that has neither yet falls back to the unkeyed derivation until then.
 */
export type CodexSecrets = { installationId?: string; idSalt?: string };

/** The stored values that are well-formed; anything else reads as absent. */
export function codexSecretsFrom(providerData: Record<string, unknown>): CodexSecrets {
  const { installationId, idSalt } = providerData;
  return {
    ...(typeof installationId === "string" && isUuid(installationId) ? { installationId } : {}),
    ...(typeof idSalt === "string" && ID_SALT.test(idSalt) ? { idSalt } : {}),
  };
}

/**
 * The stored values, with any missing or malformed one minted afresh.
 *
 * Web Crypto rather than `node:crypto`'s generators: this module is in the
 * package root's browser bundle, and `crypto.randomUUID`/`getRandomValues`
 * are the globals both runtimes share.
 */
export function ensureCodexSecrets(providerData: Record<string, unknown>): Required<CodexSecrets> {
  const stored = codexSecretsFrom(providerData);
  const salt = (): string =>
    Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  return {
    installationId: stored.installationId ?? globalThis.crypto.randomUUID(),
    idSalt: stored.idSalt ?? salt(),
  };
}

/** `seed` keyed with the credential's salt, when it has one; unchanged otherwise. */
export function keyed(salt: string | undefined, seed: string): string {
  if (salt === undefined) return seed;
  return createHmac("sha256", salt).update(seed).digest("hex");
}

/**
 * Codex's per-thread namespace for the ids of items rebuilt on every request
 * (`codex-rs/core/src/client.rs`, `prefix_namespace`): UUIDv5 of the thread id
 * under `NAMESPACE_OID`.
 */
export function prefixNamespace(threadId: string): string {
  return uuidV5(NAMESPACE_OID, threadId);
}
