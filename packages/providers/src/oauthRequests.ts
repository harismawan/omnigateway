import { type ClientProfile, mergeHeaders, orderHeaders } from "./headers.ts";
import type { AuthRequest } from "./oauthFlow.ts";
import type { HeaderPair } from "./types.ts";

/**
 * The request builders a flow yields.
 *
 * These **replaced** `postJson` and `getJson`, which were deleted once the last
 * flow stopped calling them. Those merged headers, ordered them, sent, read the
 * body and parsed it; these do the first two and stop, because under
 * `PluginOAuthFlow` the host does the rest.
 *
 * **Pure**, which is the whole difference. Keeping the merge-and-order here
 * rather than in each flow keeps it in one place: the wire bytes are pinned by
 * golden tests per provider, and five copies of a header ordering is five
 * chances for one to drift.
 *
 * Same profile, same merge, same order as the functions they replaced, so a
 * ported flow emits the bytes its own test already pinned.
 */

/**
 * The short deadline, for a call an operator is not sitting behind.
 *
 * Named for the property rather than for a caller: a usage probe wants it
 * because nothing on the request path waits for one, and grok's OIDC discovery
 * wants the same number for a different reason — a connect flow is waiting, so
 * a stalled discovery should fail fast rather than hold the operator. Calling it
 * `USAGE_TIMEOUT_MS` made the second caller read as a mistake.
 */
export const SHORT_TIMEOUT_MS = 15_000;

export function postJsonRequest(
  url: string,
  profile: ClientProfile,
  opts: { contentType: string; body: string; extraHeaders?: readonly HeaderPair[] },
): AuthRequest {
  return {
    url,
    method: "POST",
    headers: orderHeaders(
      mergeHeaders(profile.headers, [
        ["Content-Type", opts.contentType],
        ["Accept", "application/json"],
        ...(opts.extraHeaders ?? []),
      ]),
      profile.order,
    ),
    body: opts.body,
  };
}

function getRequest(
  url: string,
  profile: ClientProfile,
  authHeaders: readonly HeaderPair[],
  extraHeaders: readonly HeaderPair[],
  timeoutMs: number = SHORT_TIMEOUT_MS,
): AuthRequest {
  return {
    url,
    method: "GET",
    headers: orderHeaders(
      mergeHeaders(profile.headers, [
        ...authHeaders,
        ["Accept", "application/json"],
        ...extraHeaders,
      ]),
      profile.order,
    ),
    body: "",
    timeoutMs,
  };
}

/** Reads an account-level JSON endpoint with a bearer token. */
export function getJsonRequest(
  url: string,
  profile: ClientProfile,
  opts: { accessToken: string; extraHeaders?: readonly HeaderPair[] },
): AuthRequest {
  return getRequest(
    url,
    profile,
    [["Authorization", `Bearer ${opts.accessToken}`]],
    opts.extraHeaders ?? [],
  );
}

/**
 * Reads a JSON endpoint with no credential.
 *
 * Separate from `getJsonRequest` for the reason the two functions this pair
 * replaced were separate: sending nothing must be the stated intent, never what
 * a probe that lost its token does by accident.
 */
export function getJsonUnauthenticatedRequest(
  url: string,
  profile: ClientProfile,
  extraHeaders: readonly HeaderPair[] = [],
  /**
   * Overridable so a caller that wants this deadline for its **own** reason can
   * say so, rather than inheriting one named after a different caller. Passing
   * a longer value than the host's ceiling has no effect; the host clamps.
   */
  timeoutMs?: number,
): AuthRequest {
  return getRequest(url, profile, [], extraHeaders, timeoutMs);
}

/**
 * The parsed body, from what the host handed back.
 *
 * This is what the deleted `postJson` used to return alongside the status.
 *
 * A non-JSON body is a real answer — an HTML error page, an empty 502 — so it
 * parses to `null` and the caller falls back to the status, exactly as before.
 */
export function parsed(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
