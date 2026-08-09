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
  setupFiles,
} from "@omni/control";
import { GatewayError, type Logger, noopLogger } from "@omni/ir";
import type { Store } from "@omni/store";
import { Elysia } from "elysia";
import {
  apiErrorHandler,
  readCookie,
  readJson,
  readJsonRecord,
  requireAdmin,
  sessionCookie,
} from "./http.ts";

export type AdminDeps = {
  store: Store;
  admin: AdminAuth;
  now: () => number;
  sessionTtlMs: number;
  /** Public origin, which is what a generated client configuration points at. */
  baseUrl: string;
  logger?: Logger;
};

/**
 * The HTTP half of the control surface.
 *
 * Every handler does the same three things: prove there is an admin session,
 * call one operation in `@omni/control`, and shape the result as JSON. The
 * operations themselves — validation, store writes, ranking — live in the
 * package, so the CLI reaches them without going through a socket.
 */
export function adminRoutes(deps: AdminDeps) {
  const logger = deps.logger ?? noopLogger;
  return (
    new Elysia()
      .onError(apiErrorHandler)
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
          return {
            error: { code: "CONFLICT", message: "an admin password is already configured" },
          };
        }

        const body = await readJsonRecord(request);
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
          return {
            error: { code: "CONFLICT", message: "an admin password is already configured" },
          };
        }

        const token = await deps.admin.login(body.password);
        if (token === null) throw new GatewayError("INTERNAL", "could not create admin session");
        logger.info("admin setup completed");
        set.headers["set-cookie"] = sessionCookie(
          request,
          token,
          Math.floor(deps.sessionTtlMs / 1_000),
        );
        return { ok: true };
      })

      .post("/api/login", async ({ request, set }) => {
        const body = await readJsonRecord(request);
        const token =
          typeof body?.password === "string" ? await deps.admin.login(body.password) : null;
        if (token === null) {
          logger.info("admin login failed", { reason: "invalid credentials" });
          throw new GatewayError("AUTH", "invalid password");
        }
        logger.info("admin login succeeded");

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
        await requireAdmin(request, deps.admin);
        return { credentials: await listCredentials(deps.store) };
      })

      .get("/api/credentials/health", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        return credentialHealth(deps.store);
      })

      .patch("/api/credentials/:id", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        await patchCredential(deps, params.id, await readJson(request));
        return { ok: true };
      })

      .delete("/api/credentials/:id", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        await removeCredential(deps.store, params.id);
        return { ok: true };
      })

      .get("/api/models", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        return { models: await listModels(deps.store) };
      })

      .put("/api/models/:id", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        await putModel(deps.store, params.id, await readJson(request));
        return { ok: true };
      })

      .delete("/api/models/:id", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        await removeModel(deps.store, params.id);
        return { ok: true };
      })

      /**
       * The configuration an agent needs to talk to this gateway.
       *
       * Served rather than rendered in the browser because the numbers in it —
       * each model's context window — are resolved exactly as `GET /v1/models`
       * resolves them, and a console deriving them separately would eventually
       * disagree with the gateway about what a pool holds.
       *
       * The key is always a placeholder. The store keeps only hashes, so there is
       * no real key to render, and a snippet that carried one would leak it into
       * every screenshot of this screen.
       */
      .get("/api/agent-setup", async ({ request, query }) => {
        await requireAdmin(request, deps.admin);
        const client = query.client === "opencode" ? "opencode" : "claude";
        return { client, files: await setupFiles(deps.store, client, { baseUrl: deps.baseUrl }) };
      })

      .get("/api/keys", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        return { keys: await listKeys(deps.store) };
      })

      .post("/api/keys", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        // The only response that ever contains a key. It exists in plaintext
        // nowhere else, so an operator who loses it must issue a new one.
        return createKey(deps.store, await readJson(request));
      })

      .delete("/api/keys/:id", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        await revokeKey(deps.store, params.id);
        return { ok: true };
      })

      .get("/api/settings", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        return { settings: await getSettings(deps.store) };
      })

      .put("/api/settings", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        await putSettings(deps.store, await readJson(request));
        return { ok: true };
      })

      .post("/api/models/:id/dry-run", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        return dryRun(deps, params.id, await readJson(request));
      })

      .get("/api/usage", async ({ request, query }) => {
        await requireAdmin(request, deps.admin);
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
        await requireAdmin(request, deps.admin);
        return { logs: await recentLogs(deps.store, query.limit) };
      })
  );
}
