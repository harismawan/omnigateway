import {
  ADMIN_COOKIE,
  type AdminAuth,
  createKey,
  credentialHealth,
  dryRun,
  getSettings,
  listCredentials,
  listKeys,
  listModels,
  patchCredential,
  putModel,
  putSettings,
  queryUsage,
  recentLogs,
  removeCredential,
  removeModel,
  revokeKey,
} from "@omni/control";
import { GatewayError, HTTP_STATUS } from "@omni/ir";
import type { Store } from "@omni/store";
import { Elysia } from "elysia";
import { isRecord } from "../ingress/schemas.ts";

export type AdminDeps = {
  store: Store;
  admin: AdminAuth;
  now: () => number;
  sessionTtlMs: number;
};

function sessionCookie(request: Request, token: string, maxAge: number): string {
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

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

async function jsonRecord(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * The HTTP half of the control surface.
 *
 * Every handler does the same three things: prove there is an admin session,
 * call one operation in `@omni/control`, and shape the result as JSON. The
 * operations themselves — validation, store writes, ranking — live in the
 * package, so the CLI reaches them without going through a socket.
 */
export function adminRoutes(deps: AdminDeps) {
  const app = new Elysia().onError(({ error, set }) => {
    const gatewayError =
      error instanceof GatewayError ? error : new GatewayError("INTERNAL", "internal error");
    set.status = HTTP_STATUS[gatewayError.code];
    return { error: { code: gatewayError.code, message: gatewayError.message } };
  });

  async function requireAdmin(request: Request): Promise<void> {
    const token = readCookie(request, ADMIN_COOKIE);
    if (token === null || !(await deps.admin.verify(token))) {
      throw new GatewayError("AUTH", "admin session required");
    }
  }

  return app
    .get("/api/status", async ({ request }) => {
      const token = readCookie(request, ADMIN_COOKIE);
      return {
        configured: await deps.admin.isConfigured(),
        authenticated: token !== null && (await deps.admin.verify(token)),
      };
    })

    .post("/api/setup", async ({ request, set }) => {
      if (await deps.admin.isConfigured()) {
        set.status = 409;
        return { error: { code: "CONFLICT", message: "an admin password is already configured" } };
      }

      const body = await jsonRecord(request);
      if (typeof body?.password !== "string") {
        throw new GatewayError("BAD_REQUEST", "password is required");
      }

      let created: boolean;
      try {
        created = await deps.admin.setInitialPassword(body.password);
      } catch (error) {
        throw new GatewayError(
          "BAD_REQUEST",
          error instanceof Error ? error.message : "invalid password",
        );
      }
      if (!created) {
        set.status = 409;
        return { error: { code: "CONFLICT", message: "an admin password is already configured" } };
      }

      const token = await deps.admin.login(body.password);
      if (token === null) throw new GatewayError("INTERNAL", "could not create admin session");
      set.headers["set-cookie"] = sessionCookie(
        request,
        token,
        Math.floor(deps.sessionTtlMs / 1_000),
      );
      return { ok: true };
    })

    .post("/api/login", async ({ request, set }) => {
      const body = await jsonRecord(request);
      const token =
        typeof body?.password === "string" ? await deps.admin.login(body.password) : null;
      if (token === null) throw new GatewayError("AUTH", "invalid password");

      set.headers["set-cookie"] = sessionCookie(
        request,
        token,
        Math.floor(deps.sessionTtlMs / 1_000),
      );
      return { ok: true };
    })

    .post("/api/logout", async ({ request, set }) => {
      const token = readCookie(request, ADMIN_COOKIE);
      if (token !== null) deps.admin.logout(token);
      set.headers["set-cookie"] = sessionCookie(request, "", 0);
      return { ok: true };
    })

    .get("/api/credentials", async ({ request }) => {
      await requireAdmin(request);
      return { credentials: await listCredentials(deps.store) };
    })

    .get("/api/credentials/health", async ({ request }) => {
      await requireAdmin(request);
      return credentialHealth(deps.store);
    })

    .patch("/api/credentials/:id", async ({ request, params }) => {
      await requireAdmin(request);
      await patchCredential(deps, params.id, await request.json());
      return { ok: true };
    })

    .delete("/api/credentials/:id", async ({ request, params }) => {
      await requireAdmin(request);
      await removeCredential(deps.store, params.id);
      return { ok: true };
    })

    .get("/api/models", async ({ request }) => {
      await requireAdmin(request);
      return { models: await listModels(deps.store) };
    })

    .put("/api/models/:id", async ({ request, params }) => {
      await requireAdmin(request);
      await putModel(deps.store, params.id, await request.json());
      return { ok: true };
    })

    .delete("/api/models/:id", async ({ request, params }) => {
      await requireAdmin(request);
      await removeModel(deps.store, params.id);
      return { ok: true };
    })

    .get("/api/keys", async ({ request }) => {
      await requireAdmin(request);
      return { keys: await listKeys(deps.store) };
    })

    .post("/api/keys", async ({ request }) => {
      await requireAdmin(request);
      // The only response that ever contains a key. It exists in plaintext
      // nowhere else, so an operator who loses it must issue a new one.
      return createKey(deps.store, await request.json());
    })

    .delete("/api/keys/:id", async ({ request, params }) => {
      await requireAdmin(request);
      await revokeKey(deps.store, params.id);
      return { ok: true };
    })

    .get("/api/settings", async ({ request }) => {
      await requireAdmin(request);
      return { settings: await getSettings(deps.store) };
    })

    .put("/api/settings", async ({ request }) => {
      await requireAdmin(request);
      await putSettings(deps.store, await request.json());
      return { ok: true };
    })

    .post("/api/models/:id/dry-run", async ({ request, params }) => {
      await requireAdmin(request);
      return dryRun(deps, params.id, await request.json());
    })

    .get("/api/usage", async ({ request, query }) => {
      await requireAdmin(request);
      return {
        rows: await queryUsage(deps, {
          grain: query.grain,
          groupBy: query.groupBy,
          splitBy: query.splitBy,
          since: query.since,
          until: query.until,
        }),
      };
    })

    .get("/api/logs", async ({ request, query }) => {
      await requireAdmin(request);
      return { logs: await recentLogs(deps.store, query.limit) };
    });
}
