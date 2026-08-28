/**
 * Who is asking, and what that lets them see.
 *
 * This lives in `@omni/control` rather than beside the socket registry that
 * first needed it because the session layer here is what *decides* a principal —
 * the registry only carries one. Two copies of this union would be two answers
 * to "may this caller read that", and the copies would drift in the direction
 * that fails open.
 */

/**
 * The four callers the gateway can recognise.
 *
 * `admin` is the operator: the whole installation, mutations included. `viewer`
 * is the same breadth with nothing writable. `client` is one API key looking at
 * its own traffic and nothing else. `machine` belongs to the remote-control
 * plugin's `routes:machine` capability and is still unreachable, declared so it
 * lands later without this union learning a second shape.
 */
export type Principal =
  | { kind: "admin" }
  | { kind: "viewer" }
  | { kind: "client"; apiKeyId: string }
  | { kind: "machine"; tokenId: string; pluginId: string };

export type PrincipalKind = Principal["kind"];

/**
 * Which rows a principal may read.
 *
 * A filter over rows, deliberately not a principal and deliberately not an HTTP
 * concept: the control package must stay ignorant of who its caller is, so what
 * crosses into it is the narrowed question rather than the identity that
 * narrowed it. `store.usage.aggregate` takes an `apiKeyId`, not a `Principal`.
 */
export type Scope = { kind: "all" } | { kind: "key"; apiKeyId: string } | { kind: "none" };

export const ALL: Scope = { kind: "all" };

/**
 * Reads nothing at all.
 *
 * Its own arm rather than a key id nothing matches, because there is no such id.
 * `usage_daily.api_key_id` is `NOT NULL DEFAULT ''`, so anonymous traffic is
 * stored under the empty string — a scope of `""` reads every untagged row at
 * the daily grain while looking, in the source, exactly like "matches nothing".
 * That is what this arm exists to make unrepresentable.
 */
export const NONE: Scope = { kind: "none" };

/**
 * The one place a principal becomes a filter.
 *
 * Every read that can be narrowed goes through this function, so widening or
 * narrowing what a principal sees is one edit in one file. The alternative —
 * each route deciding for itself — is the shape `servesTarget` exists to
 * answer: five sites asked the same question separately and three of them asked
 * a different one.
 *
 * `machine` scopes to `NONE`. It reaches its plugin's own topics and has no
 * business in usage or logs, and defaulting it to `all` because the arm is
 * currently unreachable would be a fail-open waiting for the day it is not.
 */
export function scopeOf(principal: Principal): Scope {
  switch (principal.kind) {
    case "admin":
    case "viewer":
      return ALL;
    case "client":
      // A client's own id. Never `""`: a key id is minted by `crypto.randomUUID`
      // and an empty one would collide with how anonymous rows are stored.
      return principal.apiKeyId === "" ? NONE : { kind: "key", apiKeyId: principal.apiKeyId };
    case "machine":
      return NONE;
  }
}

/**
 * The `apiKeyId` a scope narrows to, or `undefined` for an unnarrowed read.
 *
 * Only defined for the `key` arm. `all` and `none` both return `undefined` and
 * mean opposite things, so **a caller must check `scope.kind === "none"` before
 * reading this** — which is why every read goes through `queryUsage` and
 * `recentLogs` rather than calling the store with this directly.
 */
export function scopeKey(scope: Scope): string | undefined {
  return scope.kind === "key" ? scope.apiKeyId : undefined;
}

/**
 * Whether this scope can match any row at all.
 *
 * Every scoped read must check this **before** calling `scopeKey`, because the
 * two answers `scopeKey` cannot tell apart — `all` and `none` — are opposites,
 * and the one it collapses them to (`undefined`) means "every row".
 *
 * The empty-string case is here rather than only in `scopeOf` because this is
 * the last gate before the store. `usage_daily.api_key_id` is `NOT NULL DEFAULT
 * ''`, so an empty id reads every anonymous row at the daily grain; a scope
 * hand-built somewhere that skipped `scopeOf` would otherwise still reach it.
 */
export function readsNothing(scope: Scope): boolean {
  return scope.kind === "none" || (scope.kind === "key" && scope.apiKeyId === "");
}
