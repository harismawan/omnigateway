import { GatewayError } from "@omni/ir";
import { type ApiKey, hashApiKey, type Store } from "@omni/store";

/**
 * Resolves an Authorization header to an API key record.
 *
 * Every failure raises the same message. Distinguishing "no such key" from
 * "key revoked" would let a caller probe which keys exist.
 *
 * The store is queried by hash, never by raw value, so a presented key that
 * does not exist leaves no trace of itself anywhere in the query path.
 */
export async function authenticateApiKey(
  store: Store,
  header: string | undefined | null,
): Promise<ApiKey> {
  const raw = extractToken(header);
  if (raw === null) throw new GatewayError("AUTH", "missing or malformed Authorization header");

  const key = await store.keys.findByHash(await hashApiKey(raw));
  if (key === null || key.revokedAt !== null) {
    throw new GatewayError("AUTH", "invalid API key");
  }

  return key;
}

/** Resolves the two supported API-key headers and rejects ambiguous credentials. */
export function apiKeyHeader(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  const xApiKey = headers.get("x-api-key");
  if (authorization === null) return xApiKey;
  if (xApiKey === null) return authorization;

  const authorizationToken = extractToken(authorization);
  const xApiKeyToken = extractToken(xApiKey);
  if (authorizationToken === null || xApiKeyToken === null || authorizationToken !== xApiKeyToken) {
    throw new GatewayError("AUTH", "conflicting API key headers");
  }
  return authorizationToken;
}

/** Accepts `Bearer <token>`, `x-api-key`-style bare tokens, or nothing. */
function extractToken(header: string | undefined | null): string | null {
  if (typeof header !== "string") return null;
  const value = header.trim();
  if (value.length === 0) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match === null ? value : (match[1] as string).trim();
}
