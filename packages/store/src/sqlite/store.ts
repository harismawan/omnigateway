import type { Database } from "bun:sqlite";
import { type Logger, noopLogger } from "@omni/ir";
import { bodiesDirFor } from "../bodies/artifact.ts";
import type {
  BodyRepo,
  ConfigRepo,
  CredentialRepo,
  KeyRepo,
  MaintenanceRepo,
  RoutingChange,
  Store,
  UsageRepo,
} from "../types.ts";
import { createBodyRepo } from "./bodies.ts";
import { createConfigRepo } from "./config.ts";
import { createCredentialRepo } from "./credentials.ts";
import { openDb } from "./db.ts";
import { createKeyRepo } from "./keys.ts";
import { createMaintenanceRepo } from "./maintenance.ts";
import { createUsageRepo } from "./usage.ts";

/**
 * One open database and the repos bound to it.
 *
 * Everything here dies together when the handle closes, which is why none of it
 * is what a caller holds.
 */
type Handle = {
  db: Database;
  credentials: CredentialRepo;
  config: ConfigRepo;
  keys: KeyRepo;
  usage: UsageRepo;
  bodies: BodyRepo;
  maintenance: MaintenanceRepo;
};

/**
 * A store whose database can be replaced underneath its holders.
 *
 * The object returned here is stable for the lifetime of the process and every
 * method on it forwards to whichever handle is current. That indirection is not
 * decoration: `store` is captured by value into five long-lived holders during
 * boot, and two dozen modules are typed against it, so a restore that closed
 * and re-opened the connection would otherwise leave all of them holding repos
 * bound to a closed `Database`. Reading `handle` per call is what makes the
 * swap invisible to them.
 *
 * Routing subscribers live out here with the outer object for the same reason:
 * a listener registered at boot must survive a restore, and one registered on a
 * handle would not.
 */
export async function createStore(opts: {
  path: string;
  encryptionKey: CryptoKey;
  logger?: Logger;
}): Promise<Store> {
  const logger = opts.logger ?? noopLogger;
  const listeners = new Set<(change: RoutingChange) => void>();
  const emit = (change: RoutingChange): void => {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        // Routing observers run after commit and must not turn a successful write
        // into a rejected repository operation.
      }
    }
  };

  const open = (): Handle => {
    const db = openDb(opts.path);
    logger.debug("store opened", { path: opts.path });
    return {
      db,
      credentials: createCredentialRepo(db, opts.encryptionKey, emit),
      config: createConfigRepo(db, emit),
      // The one repo handed the logger: an unreadable `limits` column is
      // reported rather than thrown, so this is where that trail is written.
      keys: createKeyRepo(db, logger),
      usage: createUsageRepo(db),
      // Derived from the database path rather than configured. One installation
      // is one directory: an artifact tree that could be pointed elsewhere is one
      // an operator can lose track of, and a prompt corpus is the last thing that
      // should end up somewhere nobody backs up or nobody prunes.
      bodies: createBodyRepo(db, opts.encryptionKey, bodiesDirFor(opts.path)),
      maintenance: createMaintenanceRepo(db),
    };
  };

  let handle = open();
  let live = true;

  /** Idempotent, because a restore closes before it swaps and again on the way out. */
  const closeHandle = (): void => {
    if (!live) return;
    handle.db.close();
    live = false;
  };

  return {
    databasePath: opts.path,

    // Every repo below is a stable object forwarding to the current handle.
    // Written out rather than proxied so the compiler reports a method that a
    // repo gained and this delegation did not.
    credentials: {
      list: () => handle.credentials.list(),
      listRouting: () => handle.credentials.listRouting(),
      get: (id) => handle.credentials.get(id),
      create: (input) => handle.credentials.create(input),
      update: (id, patch) => handle.credentials.update(id, patch),
      updateSecrets: (id, secrets, expiresAt) =>
        handle.credentials.updateSecrets(id, secrets, expiresAt),
      remove: (id) => handle.credentials.remove(id),
      listHealth: () => handle.credentials.listHealth(),
      saveHealth: (rows) => handle.credentials.saveHealth(rows),
      updateHealth: (id, model, apply) => handle.credentials.updateHealth(id, model, apply),
      listQuota: () => handle.credentials.listQuota(),
      saveQuota: (rows) => handle.credentials.saveQuota(rows),
      listQuotaSamples: (q) => handle.credentials.listQuotaSamples(q),
      pruneQuotaSamples: (olderThan) => handle.credentials.pruneQuotaSamples(olderThan),
    },

    config: {
      listModels: () => handle.config.listModels(),
      putModel: (model) => handle.config.putModel(model),
      removeModel: (id) => handle.config.removeModel(id),
      getSettings: () => handle.config.getSettings(),
      putSettings: (patch) => handle.config.putSettings(patch),
      getAdminPasswordHash: () => handle.config.getAdminPasswordHash(),
      setAdminPasswordHashIfAbsent: (hash) => handle.config.setAdminPasswordHashIfAbsent(hash),
      setAdminPasswordHash: (hash) => handle.config.setAdminPasswordHash(hash),
    },

    keys: {
      list: () => handle.keys.list(),
      findByHash: (hash) => handle.keys.findByHash(hash),
      create: (input) => handle.keys.create(input),
      setLimits: (id, limits) => handle.keys.setLimits(id, limits),
      revoke: (id) => handle.keys.revoke(id),
    },

    usage: {
      begin: (log) => handle.usage.begin(log),
      route: (id, target) => handle.usage.route(id, target),
      append: (log) => handle.usage.append(log),
      sweepPending: () => handle.usage.sweepPending(),
      recent: (limit) => handle.usage.recent(limit),
      aggregate: (q) => handle.usage.aggregate(q),
      sumSince: (apiKeyId, sinceMs) => handle.usage.sumSince(apiKeyId, sinceMs),
      oldestSince: (apiKeyId, sinceMs) => handle.usage.oldestSince(apiKeyId, sinceMs),
      rebuildRollup: () => handle.usage.rebuildRollup(),
      auditRollup: () => handle.usage.auditRollup(),
      prune: (olderThan) => handle.usage.prune(olderThan),
      pruneDaily: (olderThan) => handle.usage.pruneDaily(olderThan),
    },

    bodies: {
      put: (artifact) => handle.bodies.put(artifact),
      get: (requestId) => handle.bodies.get(requestId),
      prune: (olderThan) => handle.bodies.prune(olderThan),
      pruneToCap: (cap) => handle.bodies.pruneToCap(cap),
      sweepOrphans: () => handle.bodies.sweepOrphans(),
    },

    maintenance: {
      stats: () => handle.maintenance.stats(),
      vacuum: () => handle.maintenance.vacuum(),
      snapshotTo: (path) => handle.maintenance.snapshotTo(path),
      inspect: (path) => handle.maintenance.inspect(path),
    },

    routing: {
      version: () =>
        handle.db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ??
        0,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },

    async reopen() {
      closeHandle();
      handle = open();
      live = true;
    },

    close: closeHandle,
  };
}
