import { ADMIN_COOKIE, type AdminAuth, type Principal } from "@omni/control";
import { GatewayError, HTTP_STATUS } from "@omni/ir";
import { isRecord } from "../ingress/schemas.ts";

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/**
 * The scheme a proxy says the browser used, or null where none claimed one.
 *
 * `X-Forwarded-Proto` is a list when requests cross more than one hop, and the
 * client-facing hop is the first entry — the only one that describes the leg
 * the cookie has to survive.
 */
function forwardedProto(request: Request): string | null {
  const header = request.headers.get("x-forwarded-proto");
  if (header === null) return null;
  return header.split(",")[0]?.trim().toLowerCase() ?? null;
}

/**
 * The session cookie, and why `Secure` is not read off `request.url`.
 *
 * TLS usually terminates at the reverse proxy this gateway documents, so the
 * backend request arrives over plain HTTP and its URL says `http:` for a login
 * that was HTTPS end to end. Deriving the flag from that URL drops `Secure`
 * from a live admin session, and `HttpOnly` and `SameSite` buy no transport
 * confidentiality — an on-path attacker replays it on the next plain request to
 * the same host.
 *
 * Two sources, either sufficient. `baseUrl` is the configured public origin and
 * is the trustworthy one; `X-Forwarded-Proto` covers the deployment where it
 * was left at its derived default but a proxy does terminate TLS. The header is
 * unvalidated and deliberately so: forging it to `https` only adds `Secure` to
 * the forger's own cookie, which stops that cookie reaching an HTTP origin —
 * self-harm, not escalation — and forging it to `http` yields the flagless
 * cookie that is already the default. There is no value of this header that
 * widens anyone's access, so a trusted-proxy allowlist would guard nothing.
 */
export function sessionCookie(
  request: Request,
  baseUrl: string,
  token: string,
  maxAge: number,
): string {
  // Parsed rather than prefix-matched. URL schemes are case-insensitive, so
  // `HTTPS://gateway.example.com` is a valid public origin that a
  // `startsWith("https:")` test reads as plain HTTP — which drops `Secure` for
  // exactly the operator who configured TLS, the defect this function exists to
  // fix. A malformed origin is not https.
  const configured = URL.canParse(baseUrl) ? new URL(baseUrl).protocol === "https:" : false;
  const https =
    configured || forwardedProto(request) === "https" || new URL(request.url).protocol === "https:";
  const secure = https ? ["Secure"] : [];
  return [
    `${ADMIN_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    // Strict, because no legitimate cross-site request should carry this.
    "SameSite=Strict",
    ...secure,
    `Max-Age=${maxAge}`,
  ].join("; ");
}

/**
 * The principal behind a request's session cookie, or null where there is none.
 *
 * The one place a cookie becomes an identity. Every guard below is a predicate
 * over what this returns, so widening or narrowing a surface is a change to a
 * guard rather than to how sessions are read.
 */
export async function principalOf(request: Request, admin: AdminAuth): Promise<Principal | null> {
  const token = readCookie(request, ADMIN_COOKIE);
  if (token === null) return null;
  return admin.verify(token);
}

/**
 * The operator, and nobody else.
 *
 * Unchanged in meaning: it guarded every `/api/*` route when the operator was
 * the only principal, and it now says so explicitly. Every existing call site
 * keeps exactly the reach it had, which is what makes the wider surface an
 * addition rather than a rewrite of the admin one.
 */
export async function requireAdmin(request: Request, admin: AdminAuth): Promise<void> {
  const principal = await principalOf(request, admin);
  if (principal === null || principal.kind !== "admin") {
    throw new GatewayError("AUTH", "admin session required");
  }
}

/**
 * Anyone who may read the whole installation: the operator or a read-only
 * administrator.
 *
 * Opt-in per route rather than applied to a group. A group guard is one a later
 * route joins by being written in the wrong place, and the failure would be
 * silent in the widening direction. A GET nobody remembers to move here stays
 * admin-only, which is the harmless direction to be wrong in.
 */
export async function requireReader(request: Request, admin: AdminAuth): Promise<Principal> {
  const principal = await principalOf(request, admin);
  if (principal === null || (principal.kind !== "admin" && principal.kind !== "viewer")) {
    throw new GatewayError("AUTH", "admin session required");
  }
  return principal;
}

/**
 * The holder of one API key, reading their own data.
 *
 * Returns the key id rather than the principal, because that id is the only
 * thing a client route ever needs and handing back the whole principal invites
 * a route to branch on the kind it already knows.
 */
export async function requireClient(request: Request, admin: AdminAuth): Promise<string> {
  const principal = await principalOf(request, admin);
  if (principal === null || principal.kind !== "client") {
    throw new GatewayError("AUTH", "client session required");
  }
  return principal.apiKeyId;
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new GatewayError("BAD_REQUEST", "invalid JSON body");
  }
}

export async function readJsonRecord(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readJson(request);
  return isRecord(body) ? body : null;
}

export function apiErrorResponse(error: unknown): Response {
  const gatewayError =
    error instanceof GatewayError ? error : new GatewayError("INTERNAL", "internal error");
  return Response.json(
    { error: { code: gatewayError.code, message: gatewayError.message } },
    { status: HTTP_STATUS[gatewayError.code] },
  );
}

export function apiErrorHandler(input: {
  code: string | number;
  error: unknown;
}): Response | undefined {
  return input.code === "NOT_FOUND" ? undefined : apiErrorResponse(input.error);
}
