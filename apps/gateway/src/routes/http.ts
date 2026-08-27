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

export function sessionCookie(request: Request, token: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? ["Secure"] : [];
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
