import type { ClientProfile, HeaderPair } from "@omni/providers";
import { mergeHeaders, orderHeaders } from "@omni/providers";
import type { AuthRequest } from "./pluginFlow.ts";

/**
 * The request builders a flow yields, mirroring `postJson` and `getJson`.
 *
 * **Pure**, which is the whole difference: `postJson` merges headers, orders
 * them, sends, reads the body and parses it. These do the first two and stop,
 * because under `PluginOAuthFlow` the host does the rest. Splitting it here
 * rather than in each flow keeps the merge-and-order in one place — the wire
 * bytes are pinned by golden tests per provider, and five copies of a header
 * ordering is five chances for one to drift.
 *
 * Same profile, same merge, same order as the functions they replace, so a
 * ported flow emits the bytes its own test already pins.
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
 * Separate from `getJsonRequest` for the reason `getJsonUnauthenticated` is
 * separate from `getJson`: sending nothing must be the stated intent, never
 * what a probe that lost its token does by accident.
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
 * What `postJson` returned, from what the host handed back.
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
