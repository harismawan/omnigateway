import { resolve, sep } from "node:path";
import type { ProviderId } from "@omni/ir";
import { ADAPTERS, type HttpClient, nodeHttpClient, type ProviderAdapter } from "@omni/providers";
import type { Store } from "@omni/store";
import { Elysia } from "elysia";
import { createAdminAuth } from "./auth/admin.ts";
import { ApiKeyRateLimiter } from "./auth/rateLimit.ts";
import { OAUTH_PROVIDERS } from "./oauth/index.ts";
import { createRefresher } from "./oauth/refresh.ts";
import { adminRoutes } from "./routes/admin.ts";
import { connectRoutes } from "./routes/connect.ts";
import { proxyRoutes } from "./routes/proxy.ts";

export type AppDeps = {
  store: Store;
  baseUrl: string;
  now?: () => number;
  rand?: () => number;
  /** Overridden by the e2e tests to capture upstream bytes. */
  http?: HttpClient;
  adapters?: Readonly<Record<ProviderId, ProviderAdapter>>;
  requestId?: () => string;
  /** Absolute directory containing the built dashboard bundle. */
  staticDir?: string;
};

const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => Date.now());
  const rand = deps.rand ?? Math.random;
  const http = deps.http ?? nodeHttpClient();
  const adapters = deps.adapters ?? ADAPTERS;
  const requestId = deps.requestId ?? (() => `req_${crypto.randomUUID()}`);
  const rateLimiter = new ApiKeyRateLimiter(now);

  const admin = createAdminAuth(deps.store, { now, sessionTtlMs: ADMIN_SESSION_TTL_MS });
  const refresh = createRefresher({
    store: deps.store,
    providers: OAUTH_PROVIDERS,
    http,
    now,
  });

  const staticDir = deps.staticDir ? resolve(deps.staticDir) : undefined;

  return new Elysia()
    .get("/health", () => ({ ok: true }))
    .use(
      proxyRoutes({
        store: deps.store,
        adapters,
        http,
        now,
        rand,
        refresh,
        requestId,
        rateLimiter,
      }),
    )
    .use(adminRoutes({ store: deps.store, admin, now, sessionTtlMs: ADMIN_SESSION_TTL_MS }))
    .use(
      connectRoutes({
        store: deps.store,
        admin,
        providers: OAUTH_PROVIDERS,
        http,
        now,
      }),
    )
    .get("/*", ({ path, request, set }) => {
      const rawPath = new URL(request.url).pathname;
      const protectedPrefix = ["/api", "/v1", "/oauth"].some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      );
      const error = () => {
        set.status = 404;
        return { error: { code: "NOT_FOUND", message: `no route for ${path}` } };
      };

      if (!staticDir || protectedPrefix || /%2e/i.test(rawPath)) return error();

      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(rawPath);
      } catch {
        return error();
      }

      const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
      const filePath = resolve(staticDir, `.${requestedPath}`);
      if (filePath !== staticDir && !filePath.startsWith(`${staticDir}${sep}`)) return error();

      const file = Bun.file(filePath);
      if (file.size > 0) {
        const cacheControl = path.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache";
        return new Response(file, {
          headers: {
            "cache-control": cacheControl,
            "content-type": filePath.endsWith(".html") ? "text/html" : file.type,
          },
        });
      }

      if (path.startsWith("/assets/")) return error();

      const index = Bun.file(resolve(staticDir, "index.html"));
      if (index.size === 0) return error();

      return new Response(index, {
        headers: { "cache-control": "no-cache", "content-type": "text/html" },
      });
    });
}
