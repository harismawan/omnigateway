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
  readConsole,
} from "@omni/control";
import { type Coord, memoryCoord } from "@omni/coord";
import { GatewayError, HTTP_STATUS, type Logger, noopLogger, type ProviderId } from "@omni/ir";
import { ADAPTERS, type HttpClient, nodeHttpClient, type ProviderAdapter } from "@omni/providers";
import type { Store } from "@omni/store";
import { Elysia } from "elysia";
import { ApiKeyRateLimiter } from "./auth/rateLimit.ts";
import type { LoadRegistry } from "./dispatch/loadRegistry.ts";
import { createRoutingSnapshotCache } from "./dispatch/snapshotCache.ts";
import { anthropicErrorBody } from "./egress/anthropic.ts";
import { openaiErrorBody } from "./egress/openai.ts";
import { responsesErrorBody } from "./egress/responses.ts";
import type { PluginEmit } from "./logging.ts";
import type { LoadedPlugin } from "./plugins/loader.ts";
import { type MountedPlugin, pluginRoutes } from "./plugins/routes.ts";
import { pluginUiRoutes } from "./plugins/ui.ts";
import { createQuiesceLatch, type QuiesceLatch } from "./quiesce.ts";
import { adminRoutes } from "./routes/admin.ts";
import { clientRoutes } from "./routes/client.ts";
import { connectRoutes } from "./routes/connect.ts";
import { databaseRoutes } from "./routes/database.ts";
import { proxyRoutes } from "./routes/proxy.ts";
import { streamRoutes } from "./routes/stream.ts";
import { type Broadcaster, createBroadcaster } from "./stream/broadcaster.ts";
import { type ChannelRegistry, createChannelRegistry } from "./stream/channels.ts";
import { createConsoleFleet } from "./stream/consoleFleet.ts";
import { createSocketRegistry, type SocketRegistry } from "./stream/registry.ts";
import { createRing, type Ring } from "./stream/ring.ts";

export type AppDeps = {
  store: Store;
  baseUrl: string;
  now?: () => number;
  rand?: () => number;
  /** Overridden by the e2e tests to capture upstream bytes. */
  http?: HttpClient;
  adapters?: Readonly<Record<ProviderId, ProviderAdapter>>;
  requestId?: () => string;
  /**
   * Where every counter a fleet must share lives: the `1m` ring, the
   * concurrency gauge, routing load, the refresh lock. In-memory when absent,
   * which is the single-process installation.
   */
  coord?: Coord;
  /** This process's name on leases and stream declarations. Fresh when absent. */
  nodeId?: string;
  /** Reported on `/health`. `cluster` when the store is shared. */
  mode?: "single" | "cluster";
  /** Whether the coordinator's last call reached it. Absent means in memory, which is always up. */
  coordHealthy?: () => boolean;
  /** Overridden by tests that assert in-flight accounting; one per process otherwise. */
  loadRegistry?: LoadRegistry;
  /** Overridden by tests that read the concurrency gauge; one per process otherwise. */
  rateLimiter?: ApiKeyRateLimiter;
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
  /**
   * Loaded plugins and the routes each returned from `setup`.
   *
   * Empty by default, and the overwhelming majority of installs leave it that
   * way: with no plugins the block below adds one `Elysia` instance holding no
   * routes, so an install without plugins behaves exactly as it did before this
   * existed.
   */
  plugins?: readonly MountedPlugin[];
  /**
   * Emits finished requests to plugin handlers, threaded down to `finishLog`.
   *
   * Optional, and boot passes it only when at least one plugin loaded. That
   * matters because `finishLog` builds the payload before calling it, so an
   * install with no plugins would otherwise allocate a `RequestCompleted` on
   * every authenticated request to hand to a bus with no subscribers.
   */
  emit?: PluginEmit;
  /**
   * The same plugins as `plugins`, carrying what only the console needs: the
   * manifest, the nav entry, and whether the UI bundle is compatible.
   *
   * A separate field rather than a widened `plugins` because almost every test
   * that mounts plugin routes has no interest in a manifest, and requiring one
   * would make them construct a document to exercise a handler.
   */
  pluginUi?: readonly LoadedPlugin[];
  /** Re-applies loaded plugins' schema after a database swap. See `swapIn`. */
  reapplyPluginSchema?: () => Promise<void>;
  /**
   * The push transport's connection set.
   *
   * Supplied by boot so the same registry can join `stopLoops` and be closed
   * before `app.stop()`. An app built without one gets its own, which is what
   * every test that does not care about sockets wants — but nothing will close
   * it for them, so a test that opens one closes it itself.
   */
  registry?: SocketRegistry;
  /** Emits `res:*` and `stream:*` frames. Built here when boot passes none. */
  broadcaster?: Broadcaster;
  /** Replay buffer behind `stream:*`. Shares its lifetime with `broadcaster`. */
  ring?: Ring;
  /**
   * The `plugin:<id>:<name>` topics plugins have opened.
   *
   * Supplied by boot, because a plugin opens its channels inside `setup` and
   * `loadPlugins` runs before this. An app built without one gets an empty
   * registry, which is exactly what every test that mounts no plugins wants:
   * every plugin topic is then a topic nobody opened, and refused.
   */
  channels?: ChannelRegistry;
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

/**
 * Keyed on the path, and that is the hazard worth naming: the latch admits any
 * `/v1/*` route automatically, so a surface added without a line here is served
 * a dialect its client cannot parse — silently, and only while a swap is in
 * flight, which is the moment least likely to be under a test.
 */
const QUIESCE_BODY: Readonly<Record<string, (message: string) => unknown>> = {
  "/v1/chat/completions": (m) => openaiErrorBody("OVERLOADED", m),
  "/v1/responses": (m) => responsesErrorBody("OVERLOADED", m),
};

function quiesceResponse(path: string): Response {
  const render = QUIESCE_BODY[path];
  const body =
    render === undefined
      ? anthropicErrorBody("OVERLOADED", QUIESCE_MESSAGE)
      : render(QUIESCE_MESSAGE);
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
  const coord = deps.coord ?? memoryCoord();
  const nodeId = deps.nodeId ?? crypto.randomUUID();
  const logger = deps.logger ?? noopLogger;
  const rand = deps.rand ?? Math.random;
  const http = deps.http ?? nodeHttpClient({ logger, now });
  // Not normalised here. An earlier version spread an injected map onto a null
  // prototype at this line, which guarded `createApp` and nothing else —
  // `DispatchDeps` and `ProxyDeps` are public injection points that callers and
  // tests construct directly, so the map dispatch actually reads may never have
  // passed through here. The guard belongs at the read site in
  // `dispatch/index.ts`, which is on the path however the map was built.
  const adapters = deps.adapters ?? ADAPTERS;
  const requestId = deps.requestId ?? (() => `req_${crypto.randomUUID()}`);
  const rateLimiter =
    deps.rateLimiter ?? new ApiKeyRateLimiter({ store: deps.store, now, logger, coord });
  const snapshots = createRoutingSnapshotCache(deps.store, logger);

  const admin = createAdminAuth(deps.store, { now, sessionTtlMs: ADMIN_SESSION_TTL_MS, coord });
  const refresh =
    deps.refresh ??
    createRefresher({
      store: deps.store,
      providers: OAUTH_PROVIDERS,
      http,
      now,
      logger,
      coord,
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

  // Late-bound for the reason the bootstrap's copy is: channels read the socket
  // registry, and the registry must tell channels about a connection it closes
  // on its own initiative, so neither can be fully built before the other.
  let channelsRef: ChannelRegistry | undefined;
  const registry =
    deps.registry ??
    createSocketRegistry({
      logger,
      now,
      onDetach: (id, topics) => channelsRef?.closed(id, topics),
    });
  const channels = deps.channels ?? createChannelRegistry({ sockets: registry, logger });
  channelsRef = channels;
  const ring = deps.ring ?? createRing({ frames: 500, bytes: 2 * 1024 * 1024 });
  const broadcaster = deps.broadcaster ?? createBroadcaster({ registry, ring, coord, nodeId, now });
  const capture = deps.console;
  const consoleFleet = createConsoleFleet({
    coord,
    nodeId,
    local:
      capture === undefined
        ? undefined
        : (query) => readConsole(capture.deps, capture.source, query),
  });
  /**
   * The release for each admitted request, keyed by the request itself.
   *
   * Weak so a request whose after-response hook never runs is collected rather
   * than retained; the count it leaves behind costs the next quiesce its
   * deadline and nothing more.
   */
  const admitted = new WeakMap<Request, () => void>();

  /**
   * Composition order is load-bearing in one place: `pluginRoutes` sits after
   * every core route module and before the `/*` catch-all. Mounted after the
   * catch-all every plugin route would be a 404; mounted before `adminRoutes` a
   * plugin could claim `/api/keys`.
   */
  return (
    new Elysia()
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
      // `mode`, `nodeId` and `coord` are for a readiness probe and an operator
      // with curl; the console's own watcher reads `ok` alone and must keep
      // to it, because during a restart there is nothing else to read.
      .get("/health", () => ({
        ok: true,
        mode: deps.mode ?? "single",
        nodeId,
        coord:
          "healthy" in coord && !(coord as { healthy(): boolean }).healthy() ? "fallback" : "ok",
      }))
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
          coord,
          ...(deps.loadRegistry === undefined ? {} : { loadRegistry: deps.loadRegistry }),
          bodyLoggingAllowed: deps.bodyLoggingAllowed === true,
          ...(deps.emit === undefined ? {} : { emit: deps.emit }),
          broadcaster,
        }),
      )
      .use(
        adminRoutes({
          store: deps.store,
          admin,
          baseUrl: deps.baseUrl,
          bodyLoggingAllowed: deps.bodyLoggingAllowed === true,
          now,
          sessionTtlMs: ADMIN_SESSION_TTL_MS,
          logger,
          broadcaster,
          nodeId,
          consoleFleet,
          ...(deps.console === undefined ? {} : { console: deps.console }),
        }),
      )
      // After the admin surface and well before the static catch-all, like every
      // other `/api/*` group. Its paths are disjoint from the admin ones, so the
      // position is about the catch-all rather than about precedence.
      .use(
        clientRoutes({
          store: deps.store,
          admin,
          sessionTtlMs: ADMIN_SESSION_TTL_MS,
          now,
          logger,
        }),
      )
      .use(
        databaseRoutes({
          store: deps.store,
          ...(deps.reapplyPluginSchema === undefined
            ? {}
            : { reapplyPluginSchema: deps.reapplyPluginSchema }),
          admin,
          latch,
          snapshots,
          broadcaster,
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
          coord,
        }),
      )
      .use(
        pluginRoutes({
          admin,
          plugins: deps.plugins ?? [],
          logger,
        }),
      )
      .use(
        pluginUiRoutes({
          admin,
          plugins: deps.pluginUi ?? [],
          logger,
        }),
      )
      .use(
        streamRoutes({
          admin,
          registry,
          broadcaster,
          ring,
          channels,
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

        // The prefixes this catch-all must never answer for. `/oauth` was here
        // until connect moved under `/api/connect/*`; nothing serves it now, so
        // guarding it claimed a route that does not exist.
        const protectedPrefix = ["/api", "/v1"].some(
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
      })
  );
}
