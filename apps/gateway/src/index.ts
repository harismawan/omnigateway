import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type CommandRunner,
  type ConsoleDeps,
  type ConsoleSource,
  createRefresher,
  loadConfig,
  OAUTH_PROVIDERS,
  resolveConsoleSource,
  tailFile,
} from "@omni/control";
import { createLogger, type Logger } from "@omni/ir";
import { nodeHttpClient } from "@omni/providers";
import { createStore, deriveKey } from "@omni/store";
import { DASHBOARD_SDK_VERSION } from "@omnigateway/plugin-api";
import { createApp } from "./app.ts";
import { createDeferredStop, createShutdown, type Shutdown } from "./lifecycle.ts";
import { startMaintenance } from "./maintenance.ts";
import { startRefreshScheduler } from "./oauth/scheduler.ts";
import { createPluginEventBus } from "./plugins/events.ts";
import { loadPlugins } from "./plugins/loader.ts";
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

/**
 * Finds whatever captured this process's stdout, and how to read it back.
 *
 * `JOURNAL_STREAM` is systemd's own statement that it is capturing us: it sets
 * the variable on a unit's stdout, whatever the unit is called. That beats
 * looking for an installed unit file, which says a unit exists — not that this
 * process is the one it started, and not that stdout went to the journal.
 *
 * The real filesystem and a real spawn enter here and nowhere else. Both are
 * arguments to the reader, so every test of it stays hermetic.
 */
/**
 * The one place this process spawns anything.
 *
 * Shared by the console reader and by the restart, which both hand a fixed
 * argv to something outside the gateway. Injected everywhere it is used, so no
 * test spawns a process.
 */
const commandRunner: CommandRunner = async (argv) => {
  const [cmd, ...args] = argv;
  if (cmd === undefined) return { code: 1, stdout: "", stderr: "empty argv" };
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
};

function consoleSource(logFile: string | null): { source: ConsoleSource; deps: ConsoleDeps } {
  const source = resolveConsoleSource({
    logFile,
    unitInstalled: process.env.JOURNAL_STREAM !== undefined,
    // Which journal to ask, taken from systemd rather than guessed. The user
    // manager sets `MANAGERPID`, and only for the units it started; the system
    // manager is pid 1 and sets nothing. Inferring this from `getuid()` was
    // wrong in both directions — a system unit with `User=omni` has a nonzero
    // uid, and a root user manager has uid 0 — and asking the wrong journal
    // returns another service's output or nothing at all.
    scope: process.env.MANAGERPID === undefined ? "system" : "user",
  });

  return {
    source,
    deps: {
      readFile: (path, lines) => tailFile(path, lines),
      run: commandRunner,
    },
  };
}

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
  const console = consoleSource(config.logFile);
  logger.info("console log source resolved", { reason: console.source.kind });

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

  /**
   * Replaced below, once there is something to stop.
   *
   * The lifecycle routes are built with the app and the app is built before the
   * server is listening, so the stop effect they are handed reaches this
   * binding rather than a value. Calling it before then means a shutdown was
   * requested by a gateway that had not finished starting, which is not a
   * graceful anything.
   */
  let shutdown: Shutdown = (reason) => {
    logger.error("shutdown requested before the gateway was serving", { reason });
    process.exit(1);
  };

  /**
   * The installation directory, and from it the plugins directory.
   *
   * `OMNI_ROOT` first, because that is what the CLI resolves and what
   * `omni plugin install` writes into. Falling back to the database's own
   * directory covers a gateway started by hand with only `OMNI_DB_PATH`, and
   * matches how body artifacts are placed: one installation is one directory.
   *
   * Both, rather than either alone. The database can sit outside the root — a
   * `--db` flag or an ambient `OMNI_DB_PATH` puts it there, and that is a
   * supported configuration. Resolving only from the database would then send
   * the gateway looking somewhere `omni plugin install` never writes, and
   * neither side would say anything: install succeeds, verify passes, doctor
   * lists the plugin, and the gateway silently loads none of it.
   *
   * The path is logged for the same reason. A doctor that reports one directory
   * while the gateway reads another is the failure this codebase documents
   * repeatedly.
   */
  const installRoot = process.env.OMNI_ROOT ?? dirname(config.databasePath);
  const pluginRoot = join(installRoot, "plugins");
  const pluginEvents = createPluginEventBus({ logger });
  const loadedPlugins = await loadPlugins({
    root: pluginRoot,
    store,
    events: pluginEvents,
    sdkVersion: DASHBOARD_SDK_VERSION,
    logger,
    now,
  });
  for (const failure of loadedPlugins.failures) {
    // Already logged by the loader; counted here so one line states the shape of
    // the install rather than making an operator total up warnings.
    logger.warn("plugin unavailable", { plugin: failure.id, reason: failure.reason });
  }
  logger.info("plugins resolved", { count: loadedPlugins.plugins.length, path: pluginRoot });

  const app = createApp({
    store,
    baseUrl: config.baseUrl,
    http,
    now,
    refresh,
    staticDir,
    logger,
    console,
    discoveryMirrors: config.exposeClaudeCodeAliases,
    bodyLoggingAllowed: config.bodyLoggingAllowed,
    plugins: loadedPlugins.plugins.map((plugin) => ({ id: plugin.id, routes: plugin.routes })),
    pluginUi: loadedPlugins.plugins,
    // Only when something could receive one. `finishLog` builds the payload
    // before calling this, so passing it unconditionally would allocate a
    // RequestCompleted on every authenticated request of every install — and
    // almost every install runs no plugins at all.
    ...(loadedPlugins.plugins.length === 0
      ? {}
      : { emit: (event) => pluginEvents.emitRequestCompleted(event) }),
    // A restored database is any database, and one taken before a plugin was
    // installed does not carry its tables. Already-applied versions are skipped,
    // so this is cheap and idempotent.
    reapplyPluginSchema: async () => {
      for (const plugin of loadedPlugins.plugins) {
        if (plugin.migrations.length === 0) continue;
        const applied = store.plugins.migrate(plugin.id, plugin.migrations);
        if (applied.failed !== undefined) {
          throw new Error(
            `plugin ${plugin.id} migration ${applied.failed.version}: ${applied.failed.reason}`,
          );
        }
      }
    },
    lifecycle: {
      env: process.env,
      fileExists: (path) => existsSync(path),
      run: commandRunner,
      stop: createDeferredStop((reason, mode) => shutdown(reason, mode)),
    },
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

  shutdown = createShutdown({
    logger,
    // The event bus is a loop like the others: it holds a pending drain and
    // must stop before the process does, or a queued handler runs against a
    // store that is already closed.
    stopLoops: [stopMaintenance, stopRefreshScheduler, stopQuotaPoller, () => pluginEvents.stop()],
    stopServer: async () => {
      await app.stop();
    },
    closeStore: () => store.close(),
    exit: (code) => process.exit(code),
  });

  // Both signals and the lifecycle route reach the same teardown. A second
  // signal escalates, which `createShutdown` owns.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => shutdown(signal));
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
