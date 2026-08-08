import { ADMIN_COOKIE, type AdminAuth, type ConnectDeps, createConnectFlows } from "@omni/control";
import { GatewayError, HTTP_STATUS } from "@omni/ir";
import { Elysia } from "elysia";
import { isRecord } from "../ingress/schemas.ts";

export type ConnectRouteDeps = ConnectDeps & { admin: AdminAuth };

function asGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError("INTERNAL", error instanceof Error ? error.message : "internal error");
}

function errorResponse(error: unknown): Response {
  const gatewayError = asGatewayError(error);
  return new Response(
    JSON.stringify({ error: { code: gatewayError.code, message: gatewayError.message } }),
    {
      status: HTTP_STATUS[gatewayError.code],
      headers: { "content-type": "application/json" },
    },
  );
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/**
 * The HTTP half of provider authorization.
 *
 * The flow itself lives in `@omni/control`; what is here is the session check,
 * the JSON shapes the console expects, and the 202 that tells it to keep
 * polling.
 */
export function connectRoutes(deps: ConnectRouteDeps) {
  const flows = createConnectFlows(deps);

  async function requireAdmin(request: Request): Promise<void> {
    const token = readCookie(request, ADMIN_COOKIE);
    if (token === null || !(await deps.admin.verify(token))) {
      throw new GatewayError("AUTH", "admin session required");
    }
  }

  return new Elysia()
    .post("/api/connect/start", async ({ request }) => {
      try {
        await requireAdmin(request);
        const body: unknown = await request.json();
        return await flows.start(
          isRecord(body) ? body.provider : undefined,
          isRecord(body) ? body.label : undefined,
        );
      } catch (error) {
        return errorResponse(error);
      }
    })

    .post("/api/connect/finish", async ({ request }) => {
      try {
        await requireAdmin(request);
        const body: unknown = await request.json();
        return await flows.finish(
          isRecord(body) ? body.flowId : undefined,
          isRecord(body) ? body.code : undefined,
        );
      } catch (error) {
        return errorResponse(error);
      }
    })

    .post("/api/connect/poll", async ({ request, set }) => {
      try {
        await requireAdmin(request);
        const body: unknown = await request.json();
        const outcome = await flows.poll(isRecord(body) ? body.flowId : undefined);
        if (outcome.status === "pending") set.status = 202;
        return outcome;
      } catch (error) {
        return errorResponse(error);
      }
    });
}
