import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRefresher, loadConfig, OAUTH_PROVIDERS } from "@omni/control";
import { createLogger, type Logger } from "@omni/ir";
import { nodeHttpClient } from "@omni/providers";
import { createStore, deriveKey } from "@omni/store";
import { createApp } from "./app.ts";
import { startMaintenance } from "./maintenance.ts";
import { startRefreshScheduler } from "./oauth/scheduler.ts";
import { startQuotaPoller } from "./quota/poller.ts";

function stdoutLogger(level: "debug" | "info" | "warn" | "error"): Logger {
  return createLogger({
    level,
    color: Boolean(process.stdout.isTTY),
    // One synchronous write per line keeps concurrent requests from interleaving.
    // Back-pressure is intentionally ignored: dropping a line under pressure is
    // preferable to blocking dispatch on a pipe.
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });
}

// Exists before configuration is parsed, so even an invalid encryption key or
// port reaches stdout in the same structured format as every later boot error.
let logger = stdoutLogger("info");

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  logger = stdoutLogger(config.logLevel);

  if (config.logLevelFallbackFrom !== null) {
    logger.info("invalid log level; using info", { reason: config.logLevelFallbackFrom });
  }
  logger.info("omnigateway booting", { host: config.host, port: config.port });

  /**
   * Where the built dashboard lives.
   *
   * A published package ships the bundle as `public/` beside the server, while a
   * checkout builds it into the dashboard app. Trying both means the same server
   * file serves the console either way, with no env var to remember. An explicit
   * `OMNI_STATIC_DIR` is taken literally: if the operator names a directory, a
   * silent fallback to some other console would be worse than serving none.
   */
  function dashboardDir(): string {
    if (config.staticDir !== null) return config.staticDir;

    const candidates = [
      resolve(import.meta.dir, "./public"),
      resolve(import.meta.dir, "../../dashboard/dist"),
    ];
    return candidates.find((path) => existsSync(path)) ?? (candidates[1] as string);
  }

  const encryptionKey = await deriveKey(config.encryptionKey);
  const store = await createStore({
    path: config.databasePath,
    encryptionKey,
    logger,
  });

  // The gateway is one process, so a request still marked in-flight at startup
  // died with the last one. Retiring them here is what stops a crash leaving a
  // row that spins in the console forever.
  const swept = await store.usage.sweepPending();
  if (swept > 0) logger.info("retired interrupted requests", { count: swept });

  /**
   * One refresher for the whole process, shared by the request path and both
   * background loops. Its per-credential coalescing is what keeps a sweep and a
   * live request from running two refreshes against a provider that rotates
   * refresh tokens, which would invalidate every rotation but the last.
   */
  const now = () => Date.now();
  const http = nodeHttpClient({ logger, now });
  const refresh = createRefresher({ store, providers: OAUTH_PROVIDERS, http, now, logger });
  const staticDir = dashboardDir();
  logger.info(
    existsSync(staticDir) ? "dashboard directory resolved" : "dashboard directory absent",
    {
      path: staticDir,
    },
  );

  const app = createApp({
    store,
    baseUrl: config.baseUrl,
    http,
    now,
    refresh,
    staticDir,
    logger,
    discoveryMirrors: config.exposeClaudeCodeAliases,
  });

  const stopMaintenance = startMaintenance({ store, now, logger });
  const stopRefreshScheduler = startRefreshScheduler({ store, refresh, now, logger });
  const stopQuotaPoller = await startQuotaPoller({
    store,
    providers: OAUTH_PROVIDERS,
    http,
    refresh,
    now,
    logger,
  });

  // Elysia defaults Bun's socket `idleTimeout` to 30 seconds, which is shorter
  // than a request is allowed to take: `requestDeadlineMs` is 120s by default,
  // and a non-streaming request writes nothing at all until its JSON body is
  // ready. Streaming is held open by the SSE keepalive, but that cannot help a
  // buffered response, so the socket budget has to clear the request budget.
  // 255 is Bun's maximum.
  app.listen({ port: config.port, hostname: config.host, idleTimeout: 255 });
  logger.info("omnigateway listening", { host: config.host, port: config.port });

  let shuttingDown = false;

  function exitAfterClosingStore(code: number): never {
    try {
      store.close();
    } finally {
      process.exit(code);
    }
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) exitAfterClosingStore(1);

      logger.info("shutdown requested", { reason: signal });
      shuttingDown = true;
      stopMaintenance();
      stopRefreshScheduler();
      stopQuotaPoller();
      void app.stop().then(
        () => exitAfterClosingStore(0),
        (error: unknown) => {
          logger.error("shutdown failed", {
            reason: error instanceof Error ? error.message : "unknown",
          });
          return exitAfterClosingStore(1);
        },
      );
    });
  }
}

try {
  await main();
} catch (error) {
  logger.error("gateway boot failed", {
    reason: error instanceof Error ? error.message : "unknown",
  });
  process.exit(1);
}
