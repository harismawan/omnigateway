import { ADMIN_COOKIE, type AdminAuth } from "@omni/control";
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

export async function requireAdmin(request: Request, admin: AdminAuth): Promise<void> {
  const token = readCookie(request, ADMIN_COOKIE);
  if (token === null || !(await admin.verify(token))) {
    throw new GatewayError("AUTH", "admin session required");
  }
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
