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
export type Scope = { kind: "all" } | { kind: "key"; apiKeyId: string };

export const ALL: Scope = { kind: "all" };

/**
 * The one place a principal becomes a filter.
 *
 * Every read that can be narrowed goes through this function, so widening or
 * narrowing what a principal sees is one edit in one file. The alternative —
 * each route deciding for itself — is the shape `servesTarget` exists to
 * answer: five sites asked the same question separately and three of them asked
 * a different one.
 *
 * `machine` scopes to nothing readable here. It reaches its plugin's own topics
 * and has no business in usage or logs, and defaulting it to `all` because the
 * arm is currently unreachable would be a fail-open waiting for the day it is
 * reachable.
 */
export function scopeOf(principal: Principal): Scope {
  switch (principal.kind) {
    case "admin":
    case "viewer":
      return ALL;
    case "client":
      return { kind: "key", apiKeyId: principal.apiKeyId };
    case "machine":
      // Not `all`. See above.
      return { kind: "key", apiKeyId: "" };
  }
}

/**
 * The `apiKeyId` a scope narrows to, or `undefined` for an unnarrowed read.
 *
 * The shape the store takes. Kept here rather than spelled out at each call site
 * so that a caller cannot express "scoped" and pass `undefined` by accident,
 * which is the direction that reads every row.
 */
export function scopeKey(scope: Scope): string | undefined {
  return scope.kind === "all" ? undefined : scope.apiKeyId;
}

/** Whether a principal may change anything. Only the operator may. */
export function canMutate(principal: Principal): boolean {
  return principal.kind === "admin";
}
