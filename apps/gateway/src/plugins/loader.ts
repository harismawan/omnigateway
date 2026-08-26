import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { describeError, type Logger, noopLogger } from "@omni/ir";
import type { Store } from "@omni/store";
import {
  isApiCompatible,
  PLUGIN_API_VERSION,
  type PluginContext,
  type PluginDefinition,
  type PluginEvents,
  type PluginLogFields,
  type PluginLogger,
  type PluginManifest,
  type PluginMigration,
  type PluginRoute,
  type PluginStorage,
  safeParseManifest,
} from "@omnigateway/plugin-api";
import type { ChannelRegistry } from "../stream/channels.ts";
import { createPluginFetch, createPluginFiles } from "./capabilities.ts";
import type { PluginEventBus } from "./events.ts";

export type PluginLoadFailure = { id: string; reason: string };

export type LoadedPluginUi = {
  /** Absolute path to the plugin's UI bundle directory. */
  dir: string;
  entry: string;
  compatible: boolean;
  reason?: string;
};

export type LoadedPlugin = {
  id: string;
  manifest: PluginManifest;
  routes: readonly PluginRoute[];
  /**
   * Retained so a database restore can re-apply them.
   *
   * A snapshot taken before this plugin was installed does not carry its
   * tables, and the plugin stays loaded across the swap holding a context whose
   * every query would then throw until the process restarted.
   */
  migrations: readonly PluginMigration[];
  ui?: LoadedPluginUi;
};

export type PluginLoadResult = {
  plugins: LoadedPlugin[];
  failures: PluginLoadFailure[];
};

/**
 * How much of a plugin's `event` label survives into a log line.
 *
 * It is the one field a plugin controls the text of, so it is capped and
 * reduced to a conservative character set. A label like `hatch.completed`
 * passes through untouched; a prompt does not fit and would not survive the
 * filter if it did.
 */
const EVENT_MAX = 64;

function sanitizeEvent(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, EVENT_MAX);
}

/**
 * A logger a plugin can hold without widening the redaction boundary.
 *
 * `plugin` is bound here to the id the host validated, so it cannot be forged.
 * The plugin's own `event` text lands in `reason`, which is already the
 * designated free-text field — truncated by the formatter and rendered last, so
 * it cannot push a structured field out of view. Reusing that field rather than
 * adding one keeps the number of places prose can reach stdout at one.
 */
function createPluginLogger(id: string, logger: Logger): PluginLogger {
  const fields = (f: PluginLogFields | undefined) => ({
    plugin: id,
    ...(f?.event === undefined ? {} : { reason: sanitizeEvent(f.event) }),
    ...(f?.count === undefined ? {} : { count: f.count }),
    ...(f?.durationMs === undefined ? {} : { durationMs: f.durationMs }),
  });
  return {
    debug: (message, f) => logger.debug(message, fields(f)),
    info: (message, f) => logger.info(message, fields(f)),
    warn: (message, f) => logger.warn(message, fields(f)),
    error: (message, f) => logger.error(message, fields(f)),
  };
}

/** The plugin's own tables, with the host supplying the prefix on every call. */
function createPluginStorage(store: Store, id: string): PluginStorage {
  return {
    run: (sql, params) => store.plugins.run(id, sql, params === undefined ? [] : [...params]),
    all: (sql, params) => store.plugins.all(id, sql, params === undefined ? [] : [...params]),
    get: (sql, params) => store.plugins.get(id, sql, params === undefined ? [] : [...params]),
    transaction: (fn) => store.plugins.transaction(id, fn),
  };
}

function createPluginEvents(
  manifest: PluginManifest,
  bus: PluginEventBus,
): PluginEvents | undefined {
  const wantsRequest = manifest.capabilities.includes("events:request");
  const wantsLimit = manifest.capabilities.includes("events:limit");
  if (!wantsRequest && !wantsLimit) return undefined;
  // Built per declared event rather than as one switch: subscribing to an
  // undeclared event is then a type error at the plugin's own build, not a
  // silent no-op discovered when the handler never fires.
  return {
    ...(wantsRequest
      ? { onRequestCompleted: (handler) => bus.onRequestCompleted(manifest.id, handler) }
      : {}),
    ...(wantsLimit
      ? { onLimitReached: (handler) => bus.onLimitReached(manifest.id, handler) }
      : {}),
  };
}

function buildContext(deps: {
  manifest: PluginManifest;
  home: string;
  store: Store;
  events: PluginEventBus;
  channels: ChannelRegistry;
  logger: Logger;
  now: () => number;
}): PluginContext {
  const { manifest, home } = deps;
  const declared = manifest.capabilities;
  return {
    id: manifest.id,
    now: deps.now,
    logger: createPluginLogger(manifest.id, deps.logger),
    ...(declared.includes("storage")
      ? { storage: createPluginStorage(deps.store, manifest.id) }
      : {}),
    ...(declared.includes("files") ? { files: createPluginFiles(join(home, "data")) } : {}),
    ...(declared.includes("net:outbound")
      ? { net: createPluginFetch(manifest.origins ?? []) }
      : {}),
    ...(() => {
      const events = createPluginEvents(manifest, deps.events);
      return events === undefined ? {} : { events };
    })(),
    // `for` binds the id the host validated against the directory name, so the
    // `plugin:<id>:` half of every topic this plugin opens is the host's word
    // and not the plugin's — the same guarantee the storage prefix carries.
    ...(declared.includes("channels") ? { channels: deps.channels.for(manifest.id) } : {}),
    config: manifest.defaults ?? {},
  };
}

function reason(error: unknown): string {
  return describeError(error, String(error));
}

/**
 * Loads every plugin under `root`, and reports the ones that did not.
 *
 * Nothing here is fatal. A malformed manifest, an incompatible API major, an
 * entry that throws, a migration that fails — each skips one plugin, is
 * reported, and leaves the gateway booting. The asymmetry is deliberate: the
 * proxy path does not depend on any plugin, and a gateway that refuses to start
 * because an optional cosmetic feature has a syntax error has turned a nuisance
 * into an outage.
 *
 * Load order is lexicographic by id rather than whatever `readdir` returns, so
 * two installs with the same plugins behave the same way.
 */
export async function loadPlugins(deps: {
  root: string;
  store: Store;
  events: PluginEventBus;
  /**
   * Where a plugin's `setup` opens its push-socket topics.
   *
   * Required rather than optional, and deliberately so: an absent registry
   * would hand a plugin declaring `channels` a context missing the surface it
   * declared, which is the exact failure the capability list fails closed to
   * prevent.
   */
  channels: ChannelRegistry;
  sdkVersion: string;
  logger?: Logger;
  now?: () => number;
}): Promise<PluginLoadResult> {
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? Date.now;
  const plugins: LoadedPlugin[] = [];
  const failures: PluginLoadFailure[] = [];

  let entries: string[];
  try {
    const dirents = await readdir(deps.root, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    // Almost every install has no plugins and never creates the directory. A
    // warning here would appear in every boot log for a feature nobody uses.
    return { plugins, failures };
  }

  for (const id of entries.sort()) {
    // `resolve`, not `join`: the containment check below compares this against
    // `resolve(home, entry)`, which is always absolute. A relative root would
    // therefore never match and every plugin would be refused as "outside the
    // plugin directory" — which is exactly what shipped. The gateway derives
    // its root from the database path, and that path is relative whenever the
    // installation is configured with a bare filename, so this was the ordinary
    // case rather than an exotic one.
    const home = resolve(deps.root, id);
    const fail = (why: string): void => {
      failures.push({ id, reason: why });
      logger.warn("plugin skipped", { plugin: id, reason: why });
    };

    let manifest: PluginManifest;
    try {
      const raw = await readFile(join(home, "omni-plugin.json"), "utf8");
      const parsed = safeParseManifest(JSON.parse(raw) as unknown);
      if (!parsed.ok) {
        fail(parsed.reason);
        continue;
      }
      manifest = parsed.manifest;
    } catch (error) {
      fail(reason(error));
      continue;
    }

    // The directory name wins over the manifest. Everything downstream — the
    // URL segment, the table prefix, the log field — is derived from the path,
    // so trusting the document over its location would let a plugin claim
    // another plugin's namespace merely by being unpacked beside it.
    if (manifest.id !== id) {
      fail(`manifest id ${manifest.id} does not match its directory ${id}`);
      continue;
    }

    if (!isApiCompatible(manifest)) {
      fail(`plugin api ${manifest.api} is not supported by this host (api ${PLUGIN_API_VERSION})`);
      continue;
    }

    let routes: readonly PluginRoute[] = [];
    let migrations: readonly PluginMigration[] = [];
    if (manifest.server !== undefined) {
      const entry = resolve(home, manifest.server);
      // A second lexical check. The manifest schema already rejects `..` and
      // absolute entries; this catches a join that escaped anyway. It does NOT
      // resolve symlinks — `resolve` is purely lexical — and it does not need
      // to: the server entry is imported into this process with full privileges
      // either way, so a link is not the boundary here. The `files` capability
      // is where link resolution matters, and it does it there.
      if (entry !== home && !entry.startsWith(`${home}${sep}`)) {
        fail(`server entry resolves outside the plugin directory`);
        continue;
      }

      let definition: PluginDefinition;
      try {
        const module: unknown = await import(entry);
        const candidate = (module as { default?: unknown }).default;
        if (
          typeof candidate !== "object" ||
          candidate === null ||
          typeof (candidate as PluginDefinition).setup !== "function"
        ) {
          fail("server entry has no default export with a setup function");
          continue;
        }
        definition = candidate as PluginDefinition;
      } catch (error) {
        fail(reason(error));
        continue;
      }

      migrations = definition.migrations ?? [];
      if (migrations.length > 0) {
        const applied = deps.store.plugins.migrate(id, migrations);
        if (applied.failed !== undefined) {
          // Whatever committed before the failure stays applied and stays
          // recorded — see the store's migrate for why a batch transaction here
          // would be worse.
          fail(`migration ${applied.failed.version} failed: ${applied.failed.reason}`);
          continue;
        }
      }

      try {
        const context = buildContext({
          manifest,
          home,
          store: deps.store,
          events: deps.events,
          channels: deps.channels,
          logger,
          now,
        });
        const result = await definition.setup(context);
        routes = result?.routes ?? [];
      } catch (error) {
        fail(reason(error));
        continue;
      }
    }

    const loaded: LoadedPlugin = { id, manifest, routes, migrations };
    if (manifest.ui !== undefined && manifest.sdk !== undefined) {
      /**
       * `manifest.ui` is relative to the plugin's home, like `server`. Only the
       * `ui/` subtree is ever served, so the stored entry is relative to *that*
       * and the prefix is stripped exactly once, here.
       *
       * Getting this wrong is silent in both directions. Leaving the prefix on
       * makes the catalog advertise `/plugin-assets/<id>/ui/index.js`, which
       * resolves to `<home>/ui/ui/index.js` and 404s — the console then reports
       * a broken plugin rather than a broken host. Serving from `<home>` instead
       * would fix the URL by publishing `server/` and the manifest to anyone who
       * asks, since bundles are deliberately unauthenticated.
       */
      const UI_DIR = "ui/";
      if (!manifest.ui.startsWith(UI_DIR)) {
        fail(`ui entry must live under ${UI_DIR}, got ${manifest.ui}`);
        continue;
      }
      const compatible = Bun.semver.satisfies(deps.sdkVersion, manifest.sdk);
      loaded.ui = {
        dir: home,
        entry: manifest.ui.slice(UI_DIR.length),
        compatible,
        // An incompatible UI disables only the UI. The server half keeps
        // running: a plugin collecting data should not go dark because the
        // dashboard's React moved, and the operator gets a disabled nav entry
        // carrying this reason rather than a blank screen.
        ...(compatible
          ? {}
          : { reason: `requires dashboard sdk ${manifest.sdk}, host ships ${deps.sdkVersion}` }),
      };
    }
    plugins.push(loaded);
    logger.info("plugin loaded", { plugin: id });
  }

  return { plugins, failures };
}
