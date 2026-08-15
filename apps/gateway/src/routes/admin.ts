import {
  ADMIN_COOKIE,
  type AdminAuth,
  type ConsoleDeps,
  type ConsoleSource,
  consoleLimit,
  createApiKeyCredential,
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
  quotaHistory,
  readConsole,
  recentLogs,
  removeCredential,
  removeModel,
  revokeKey,
  setupFiles,
} from "@omni/control";
import { GatewayError, type Logger, noopLogger, parseLogLevel } from "@omni/ir";
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
  discoveryMirrors?: boolean;
  logger?: Logger;
  /**
   * Where this process's stdout was captured, and how to read it.
   *
   * Resolved once at boot rather than per request: the answer is a function of
   * configuration and of which supervisor started the process, neither of which
   * changes while it runs. Absent means the console route reports that nothing
   * captured stdout — the ordinary state under `bun run dev`.
   */
  console?: { source: ConsoleSource; deps: ConsoleDeps };
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

      .post("/api/credentials", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        const body = await readJsonRecord(request);
        if (body === null) throw new GatewayError("BAD_REQUEST", "credential body is required");
        return {
          credential: await createApiKeyCredential(
            deps.store,
            { provider: body.provider, apiKey: body.apiKey, ...body },
            logger,
          ),
        };
      })

      .get("/api/credentials/health", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        return credentialHealth(deps);
      })

      /**
       * Retained quota readings, for the one surface that charts them.
       *
       * Samples only: the burn estimate rides `/api/credentials/health`, which
       * every board already loads, and is not repeated here. Clamping the span
       * to the retention window is `@omni/control`'s rule, not this handler's.
       */
      .get("/api/credentials/quota/history", async ({ request, query }) => {
        await requireAdmin(request, deps.admin);
        return {
          samples: await quotaHistory(deps, {
            since: query.since,
            until: query.until,
            credentialId: query.credentialId,
          }),
        };
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
       * Served rather than rendered in the browser so Claude model mappings and
       * opencode limits use the same pool descriptions as the CLI. A browser
       * deriving either separately would eventually disagree with the gateway.
       *
       * The key is always a placeholder. The store keeps only hashes, so there is
       * no real key to render, and a snippet that carried one would leak it into
       * every screenshot of this screen.
       */
      .get("/api/agent-setup", async ({ request, query }) => {
        await requireAdmin(request, deps.admin);
        const client = query.client === "opencode" ? "opencode" : "claude";
        const defaultModel = query.defaultModel;
        if (!defaultModel) {
          throw new GatewayError("BAD_REQUEST", `defaultModel is required for ${client} setup`);
        }
        try {
          return {
            client,
            files: await setupFiles(
              deps.store,
              client,
              {
                baseUrl: deps.baseUrl,
                discoveryMirrors: deps.discoveryMirrors === true,
              },
              {
                defaultModel,
                ...(query.fableModel ? { fableModel: query.fableModel } : {}),
                ...(query.opusModel ? { opusModel: query.opusModel } : {}),
                ...(query.sonnetModel ? { sonnetModel: query.sonnetModel } : {}),
                ...(query.haikuModel ? { haikuModel: query.haikuModel } : {}),
              },
            ),
          };
        } catch (error) {
          throw new GatewayError(
            "BAD_REQUEST",
            error instanceof Error ? error.message : "invalid Claude model mapping",
          );
        }
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

      /**
       * The gateway's own output, as opposed to `/api/logs`, which is what
       * clients asked for.
       *
       * The `journalctl` argv is fixed and nothing from the query reaches it:
       * `lines` is clamped to an integer and `level` is parsed to one of four
       * words or dropped. The call goes through the injected runner, so a test
       * never spawns anything.
       */
      .get("/api/console", async ({ request, query }) => {
        await requireAdmin(request, deps.admin);
        if (deps.console === undefined) return { source: "none", lines: [] };

        const level = parseLogLevel(query.level);
        const since = Number(query.since);
        return readConsole(deps.console.deps, deps.console.source, {
          lines: consoleLimit(query.lines),
          ...(level === null ? {} : { level }),
          ...(Number.isFinite(since) && since > 0 ? { since } : {}),
        });
      })
  );
}
