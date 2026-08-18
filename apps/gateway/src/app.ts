import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  type ConsoleDeps,
  type ConsoleSource,
  createAdminAuth,
  createRefresher,
  type DatabaseDeps,
  type LifecycleDeps,
  nodeDatabaseFs,
  OAUTH_PROVIDERS,
  type Refresher,
} from "@omni/control";
import { GatewayError, HTTP_STATUS, type Logger, noopLogger, type ProviderId } from "@omni/ir";
import { ADAPTERS, type HttpClient, nodeHttpClient, type ProviderAdapter } from "@omni/providers";
import type { Store } from "@omni/store";
import { Elysia } from "elysia";
import { ApiKeyRateLimiter } from "./auth/rateLimit.ts";
import type { LoadRegistry } from "./dispatch/loadRegistry.ts";
import { createRoutingSnapshotCache } from "./dispatch/snapshotCache.ts";
import { anthropicErrorBody } from "./egress/anthropic.ts";
import { openaiErrorBody } from "./egress/openai.ts";
import { createQuiesceLatch, type QuiesceLatch } from "./quiesce.ts";
import { adminRoutes } from "./routes/admin.ts";
import { connectRoutes } from "./routes/connect.ts";
import { databaseRoutes } from "./routes/database.ts";
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
  /**
   * The admission gate over `/v1/*`, shared with whatever closes it.
   *
   * One per process, built here unless a caller wants to hold the handle: a
   * restore closes this and the database routes are what reopen it.
   */
  latch?: QuiesceLatch;
  /** Filesystem effects the database panel runs on. Real ones by default. */
  databaseFs?: DatabaseDeps["fs"];
  /**
   * How this process stops, and what it would ask to be restarted by.
   *
   * Supplied by the bootstrap, which is the only place holding the running
   * server, the store, and the background loops. Without it the capability is
   * still reported honestly, and the two mutating routes fail rather than
   * answering `ok` for something that did not happen.
   */
  lifecycle?: LifecycleDeps;
};

const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * What a client is told while the database is being replaced.
 *
 * 503 with a `retry-after`, in the surface's own error shape, because the
 * caller is an SDK: an agent that retries in five seconds gets its answer, and
 * one that does not at least fails with the vocabulary it parses. Rendered from
 * the same encoders the proxy uses, so this is not a second construction of an
 * error body that could drift from the one every other refusal returns.
 */
const QUIESCE_MESSAGE = "the gateway is briefly quiesced for database maintenance";

function quiesceResponse(path: string): Response {
  const body =
    path === "/v1/chat/completions"
      ? openaiErrorBody("OVERLOADED", QUIESCE_MESSAGE)
      : anthropicErrorBody("OVERLOADED", QUIESCE_MESSAGE);
  return new Response(JSON.stringify(body), {
    status: HTTP_STATUS.OVERLOADED,
    headers: { "content-type": "application/json", "retry-after": "5" },
  });
}

/**
 * Whether this request is client traffic, which is the only thing the latch
 * gates.
 *
 * `/api/*` and `/health` are deliberately outside it. A restore is watched from
 * the console and reported through it, so a latch that covered the whole server
 * would black out the dashboard at the exact moment an operator needs to see
 * whether their database came back — and would take `/health` with it, which is
 * what a load balancer reads.
 */
function isClientTraffic(path: string): boolean {
  return path === "/v1" || path.startsWith("/v1/");
}

/**
 * The lifecycle seam for an app nobody handed a stop effect to.
 *
 * The capability is still read from the real environment, because reporting
 * "no supervisor" on a machine that has one would be a lie in the other
 * direction. What is missing is the ability to act, so acting fails loudly
 * rather than returning `ok` for a restart that never happened.
 */
function absentLifecycle(): LifecycleDeps {
  const refuse = (): never => {
    throw new GatewayError("INTERNAL", "this process has no lifecycle control installed");
  };
  return {
    env: process.env,
    fileExists: (path) => existsSync(path),
    run: async () => refuse(),
    stop: refuse,
  };
}

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

  const latch = deps.latch ?? createQuiesceLatch();
  /**
   * The release for each admitted request, keyed by the request itself.
   *
   * Weak so a request whose after-response hook never runs is collected rather
   * than retained; the count it leaves behind costs the next quiesce its
   * deadline and nothing more.
   */
  const admitted = new WeakMap<Request, () => void>();

  return new Elysia()
    .onRequest(({ request }) => {
      const path = new URL(request.url).pathname;
      if (!isClientTraffic(path)) return;
      const release = latch.enter();
      if (release === null) return quiesceResponse(path);
      admitted.set(request, release);
    })
    .onAfterResponse(({ request }) => {
      // Fires once the response has been handed back, which for a stream is
      // before its body has finished. A quiesce therefore waits for requests to
      // be answered rather than for streams to end — which is why its wait is
      // bounded, and why `/v1` is refused for the whole operation rather than
      // only until the count reaches zero.
      admitted.get(request)?.();
      admitted.delete(request);
    })
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
      databaseRoutes({
        store: deps.store,
        admin,
        latch,
        snapshots,
        fs: deps.databaseFs ?? nodeDatabaseFs(),
        now,
        logger,
        lifecycle: deps.lifecycle ?? absentLifecycle(),
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
