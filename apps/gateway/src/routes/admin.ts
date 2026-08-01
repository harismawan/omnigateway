import { GatewayError, HTTP_STATUS } from "@omni/ir";
import {
  generateApiKey,
  hashApiKey,
  type Settings,
  type Store,
  type VirtualModel,
} from "@omni/store";
import { Elysia } from "elysia";
import { z } from "zod";
import { ADMIN_COOKIE, type AdminAuth } from "../auth/admin.ts";
import { parseOrThrow } from "../ingress/schemas.ts";

export type AdminDeps = {
  store: Store;
  admin: AdminAuth;
  now: () => number;
  sessionTtlMs: number;
};
const MAX_LOG_LIMIT = 500;

const providerId = z.enum(["anthropic", "openai", "kimi"]);

const modelSchema = z.object({
  id: z.string().min(1),
  strategy: z.enum(["score", "priority", "roundRobin", "weighted"]),
  isAlias: z.boolean(),
  targets: z
    .array(
      z
        .object({
          provider: providerId,
          model: z.string().min(1),
          tier: z.number().int().min(1),
          weight: z.number().positive(),
          costPerMTok: z.object({
            input: z.number().min(0),
            output: z.number().min(0),
            cacheRead: z.number().min(0),
          }),
          capabilities: z.object({
            tools: z.boolean(),
            images: z.boolean(),
            reasoning: z.boolean(),
          }),
        })
        .or(
          z.object({
            provider: providerId,
            model: z.string().min(1),
            tier: z.number().int().min(1),
            weight: z.number().positive(),
            costPerMTok: z.object({
              input: z.number().min(0),
              output: z.number().min(0),
            }),
            capabilities: z.object({
              tools: z.boolean(),
              images: z.boolean(),
              reasoning: z.boolean(),
            }),
          }),
        ),
    )
    .min(1, "a virtual model needs at least one target"),
});

const keyCreateSchema = z
  .object({
    label: z.string().min(1).default("api key"),
    /** Null means every configured model. An empty array would mean none. */
    modelAllowlist: z.array(z.string().min(1)).nullable().default(null),
    rateLimitPerMin: z.number().int().positive().nullable().default(null),
  })
  .strict();

const settingsSchema = z.object({
  weights: z
    .object({
      tier: z.number(),
      health: z.number(),
      quota: z.number(),
      cost: z.number(),
      latency: z.number(),
      recency: z.number(),
    })
    .strict(),
  maxAttempts: z.number().int().min(1).max(10),
  requestDeadlineMs: z.number().int().positive(),
  breakerThreshold: z.number().int().min(1),
  breakerCooldownMs: z.number().int().positive(),
  logRetentionDays: z.number().int().min(1),
});

/** Only these credential fields are operator-editable. Secrets are not. */
const credentialPatchSchema = z
  .object({
    label: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    tier: z.number().int().min(1).optional(),
    weight: z.number().positive().optional(),
  })
  .strict();

/** Mirrors `UsageQuery["groupBy"]` exactly; the store whitelists the column. */
const groupBySchema = z.enum(["credential", "model", "apiKey", "hour"]);

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

export function adminRoutes(deps: AdminDeps) {
  const app = new Elysia().onError(({ error, set }) => {
    const gatewayError =
      error instanceof GatewayError
        ? error
        : new GatewayError("INTERNAL", error instanceof Error ? error.message : "internal error");
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

      const body = (await request.json()) as { password?: unknown };
      if (typeof body.password !== "string") {
        throw new GatewayError("BAD_REQUEST", "password is required");
      }

      try {
        await deps.admin.setPassword(body.password);
      } catch (error) {
        throw new GatewayError(
          "BAD_REQUEST",
          error instanceof Error ? error.message : "invalid password",
        );
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
      const body = (await request.json()) as { password?: unknown };
      const token =
        typeof body.password === "string" ? await deps.admin.login(body.password) : null;
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
      const credentials = await deps.store.credentials.list();
      // `secrets` is a function on the view; spreading drops it, but the
      // explicit projection makes that a decision rather than an accident.
      return {
        credentials: credentials.map((c) => ({
          id: c.id,
          provider: c.provider,
          label: c.label,
          authType: c.authType,
          enabled: c.enabled,
          tier: c.tier,
          weight: c.weight,
          expiresAt: c.expiresAt,
          accountEmail: c.accountEmail,
          providerData: c.providerData,
          hasRefreshToken: c.hasRefreshToken,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
      };
    })

    .patch("/api/credentials/:id", async ({ request, params }) => {
      await requireAdmin(request);
      const patch = parseOrThrow(credentialPatchSchema, await request.json());
      const existing = await deps.store.credentials.get(params.id);
      if (existing === null) throw new GatewayError("BAD_REQUEST", "no such credential");

      await deps.store.credentials.update(params.id, {
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.tier === undefined ? {} : { tier: patch.tier }),
        ...(patch.weight === undefined ? {} : { weight: patch.weight }),
      });
      return { ok: true };
    })

    .delete("/api/credentials/:id", async ({ request, params }) => {
      await requireAdmin(request);
      await deps.store.credentials.remove(params.id);
      return { ok: true };
    })

    .get("/api/models", async ({ request }) => {
      await requireAdmin(request);
      return { models: await deps.store.config.listModels() };
    })

    .put("/api/models/:id", async ({ request, params }) => {
      await requireAdmin(request);
      const model: VirtualModel = parseOrThrow(modelSchema, await request.json());
      if (model.id !== params.id) {
        throw new GatewayError("BAD_REQUEST", "model id in the path and body must match");
      }
      await deps.store.config.putModel(model);
      return { ok: true };
    })

    .delete("/api/models/:id", async ({ request, params }) => {
      await requireAdmin(request);
      await deps.store.config.removeModel(params.id);
      return { ok: true };
    })

    .get("/api/keys", async ({ request }) => {
      await requireAdmin(request);
      // The store never holds the raw key, only its hash, so there is nothing
      // to strip here — but the shape is explicit for the same reason.
      const keys = await deps.store.keys.list();
      return {
        keys: keys.map((k) => ({
          id: k.id,
          label: k.label,
          // The display prefix, never the key. `hash` is deliberately absent:
          // it is not a secret, but publishing it invites offline guessing.
          prefix: k.prefix,
          modelAllowlist: k.modelAllowlist,
          rateLimitPerMin: k.rateLimitPerMin,
          createdAt: k.createdAt,
          revokedAt: k.revokedAt,
        })),
      };
    })

    .post("/api/keys", async ({ request }) => {
      await requireAdmin(request);
      const body = parseOrThrow(keyCreateSchema, await request.json());

      const raw = generateApiKey();
      const created = await deps.store.keys.create({
        id: crypto.randomUUID(),
        label: body.label,
        prefix: raw.slice(0, 12),
        hash: await hashApiKey(raw),
        modelAllowlist: body.modelAllowlist,
        rateLimitPerMin: body.rateLimitPerMin,
      });

      // The only response that ever contains a key. It exists in plaintext
      // nowhere else, so an operator who loses it must issue a new one.
      return { id: created.id, label: created.label, prefix: created.prefix, key: raw };
    })

    .delete("/api/keys/:id", async ({ request, params }) => {
      await requireAdmin(request);
      // Revoke, not delete. The usage rows reference this id, and a report that
      // silently loses its attribution is worse than one naming a dead key.
      await deps.store.keys.revoke(params.id);
      return { ok: true };
    })

    .get("/api/settings", async ({ request }) => {
      await requireAdmin(request);
      return { settings: await deps.store.config.getSettings() };
    })

    .put("/api/settings", async ({ request }) => {
      await requireAdmin(request);
      const settings: Settings = parseOrThrow(settingsSchema, await request.json());
      await deps.store.config.putSettings(settings);
      return { ok: true };
    })

    .get("/api/usage", async ({ request, query }) => {
      await requireAdmin(request);
      const groupBy = parseOrThrow(groupBySchema, query.groupBy ?? "model");
      const since = typeof query.since === "string" ? Number(query.since) : 0;
      const until = typeof query.until === "string" ? Number(query.until) : deps.now();

      return {
        rows: await deps.store.usage.aggregate({
          groupBy,
          since: Number.isFinite(since) ? since : 0,
          until: Number.isFinite(until) ? until : deps.now(),
        }),
      };
    })

    .get("/api/logs", async ({ request, query }) => {
      await requireAdmin(request);
      const requested = typeof query.limit === "string" ? Number(query.limit) : 100;
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(1, requested), MAX_LOG_LIMIT)
        : 100;
      return { logs: await deps.store.usage.recent(limit) };
    });
}
