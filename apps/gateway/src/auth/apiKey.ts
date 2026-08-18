import { GatewayError, type Logger, noopLogger } from "@omni/ir";
import { type ApiKey, hashApiKey, type LimitConfig, type Store } from "@omni/store";

/**
 * A key that passed the chokepoint below.
 *
 * The narrowed `limits` is the whole value of the type: `ApiKey.limits` is
 * nullable because a stored row can be unreadable, and this says that every
 * caller downstream of authentication has already been spared that case.
 */
export type AuthenticatedKey = ApiKey & { limits: LimitConfig };

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
  logger: Logger = noopLogger,
): Promise<AuthenticatedKey> {
  const raw = extractToken(header);
  if (raw === null) throw new GatewayError("AUTH", "missing or malformed Authorization header");

  const key = await store.keys.findByHash(await hashApiKey(raw));
  if (key === null || key.revokedAt !== null) {
    throw new GatewayError("AUTH", "invalid API key");
  }

  /**
   * A key whose stored limits this build cannot read is refused, never served.
   *
   * `INTERNAL` rather than `AUTH`: the credential is fine and the client did
   * nothing wrong, so telling it otherwise would send an operator hunting a key
   * that works. What is broken is the installation's own configuration, and no
   * retry the client can make will fix it. Serving the request instead would
   * ignore a ceiling the operator explicitly set, which is the one outcome the
   * nullable `limits` exists to prevent.
   *
   * The row is named to stdout and nowhere else. The client is told what is
   * true and nothing more: not which key, not why, not from where.
   */
  const limits = key.limits;
  if (limits === null) {
    logger.error("api key refused: limits unreadable", { apiKeyId: key.id });
    throw new GatewayError("INTERNAL", "api key configuration is unusable");
  }

  return { ...key, limits };
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
