import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  type ConsoleDeps,
  type ConsoleSource,
  createAdminAuth,
  createRefresher,
  OAUTH_PROVIDERS,
  type Refresher,
} from "@omni/control";
import { type Logger, noopLogger, type ProviderId } from "@omni/ir";
import { ADAPTERS, type HttpClient, nodeHttpClient, type ProviderAdapter } from "@omni/providers";
import type { Store } from "@omni/store";
import { Elysia } from "elysia";
import { ApiKeyRateLimiter } from "./auth/rateLimit.ts";
import type { LoadRegistry } from "./dispatch/loadRegistry.ts";
import { createRoutingSnapshotCache } from "./dispatch/snapshotCache.ts";
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
  /** Overridden by tests that assert in-flight accounting; one per process otherwise. */
  loadRegistry?: LoadRegistry;
  /**
   * Shared with the background loops by the bootstrap.
   *
   * One refresher process-wide, because its coalescing map is what stops a
   * scheduled sweep and a live request from each running a refresh against a
   * provider that rotates refresh tokens. Two refreshers would each be
   * internally consistent and jointly wrong.
   */
  refresh?: Refresher;
  /** Absolute directory containing the built dashboard bundle. */
  staticDir?: string;
  /**
   * Whether `GET /v1/models` also advertises `claude/<id>` discovery mirrors,
   * which is the only way a pool named anything else appears in Claude Code's
   * model picker. Startup configuration, read once from the environment.
   */
  discoveryMirrors?: boolean;
  /**
   * Whether `OMNI_BODY_LOGGING_ALLOWED` was set. Startup configuration, read
   * once from the environment: the runtime setting is the half an operator
   * flips mid-incident, and this is the half that says they may.
   */
  bodyLoggingAllowed?: boolean;
  logger?: Logger;
  /** Where this process's stdout was captured, when anything captured it. */
  console?: { source: ConsoleSource; deps: ConsoleDeps };
};

const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? noopLogger;
  const rand = deps.rand ?? Math.random;
  const http = deps.http ?? nodeHttpClient({ logger, now });
  const adapters = deps.adapters ?? ADAPTERS;
  const requestId = deps.requestId ?? (() => `req_${crypto.randomUUID()}`);
  const rateLimiter = new ApiKeyRateLimiter(now);
  const snapshots = createRoutingSnapshotCache(deps.store, logger);

  const admin = createAdminAuth(deps.store, { now, sessionTtlMs: ADMIN_SESSION_TTL_MS });
  const refresh =
    deps.refresh ??
    createRefresher({
      store: deps.store,
      providers: OAUTH_PROVIDERS,
      http,
      now,
      logger,
    });

  const staticDir = deps.staticDir ? resolve(deps.staticDir) : undefined;
  let staticRoot: string | undefined;
  if (staticDir) {
    try {
      staticRoot = realpathSync(staticDir);
    } catch {
      // An absent bundle is handled as an unrouted dashboard request.
    }
  }

  return new Elysia()
    .get("/health", () => ({ ok: true }))
    .use(
      proxyRoutes({
        store: deps.store,
        snapshots,
        adapters,
        http,
        now,
        rand,
        refresh,
        requestId,
        rateLimiter,
        logger,
        ...(deps.loadRegistry === undefined ? {} : { loadRegistry: deps.loadRegistry }),
        discoveryMirrors: deps.discoveryMirrors === true,
        bodyLoggingAllowed: deps.bodyLoggingAllowed === true,
      }),
    )
    .use(
      adminRoutes({
        store: deps.store,
        admin,
        baseUrl: deps.baseUrl,
        discoveryMirrors: deps.discoveryMirrors === true,
        bodyLoggingAllowed: deps.bodyLoggingAllowed === true,
        now,
        sessionTtlMs: ADMIN_SESSION_TTL_MS,
        logger,
        ...(deps.console === undefined ? {} : { console: deps.console }),
      }),
    )
    .use(
      connectRoutes({
        store: deps.store,
        admin,
        providers: OAUTH_PROVIDERS,
        http,
        now,
        logger,
      }),
    )
    .get("/*", ({ path, request, set }) => {
      const rawPath = new URL(request.url).pathname;
      const error = () => {
        set.status = 404;
        return { error: { code: "NOT_FOUND", message: `no route for ${path}` } };
      };
      if (!staticRoot || /%2f|%5c/i.test(rawPath)) return error();

      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(rawPath);
      } catch {
        return error();
      }

      const protectedPrefix = ["/api", "/v1", "/oauth"].some(
        (prefix) => decodedPath === prefix || decodedPath.startsWith(`${prefix}/`),
      );
      if (protectedPrefix) return error();

      const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
      const filePath = resolve(staticRoot, `.${requestedPath}`);
      if (filePath !== staticRoot && !filePath.startsWith(`${staticRoot}${sep}`)) return error();

      let resolvedFilePath: string | undefined;
      try {
        resolvedFilePath = realpathSync(filePath);
      } catch {
        // A missing file may be a client-side navigation below.
      }
      if (
        resolvedFilePath &&
        resolvedFilePath !== staticRoot &&
        !resolvedFilePath.startsWith(`${staticRoot}${sep}`)
      ) {
        return error();
      }

      const file = resolvedFilePath ? Bun.file(resolvedFilePath) : undefined;
      if (file && file.size > 0 && resolvedFilePath) {
        const cacheControl = decodedPath.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache";
        return new Response(file, {
          headers: {
            "cache-control": cacheControl,
            "content-type": resolvedFilePath.endsWith(".html") ? "text/html" : file.type,
          },
        });
      }

      const isNavigation = request.headers.get("accept")?.includes("text/html") ?? false;
      if (decodedPath.startsWith("/assets/") || !isNavigation) return error();

      const indexPath = resolve(staticRoot, "index.html");
      const index = Bun.file(indexPath);
      if (index.size === 0) return error();

      return new Response(index, {
        headers: { "cache-control": "no-cache", "content-type": "text/html" },
      });
    });
}
