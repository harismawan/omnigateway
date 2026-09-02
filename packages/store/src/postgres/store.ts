import { type Logger, noopLogger } from "@omni/ir";
import type { RoutingChange, Store } from "../types.ts";
import { createBodyRepo } from "./bodies.ts";
import { createConfigRepo } from "./config.ts";
import { createCredentialRepo } from "./credentials.ts";
import { num, openPg, type Rows } from "./db.ts";
import { createKeyRepo } from "./keys.ts";
import { createMaintenanceRepo } from "./maintenance.ts";
import { createPluginRepo } from "./plugins.ts";
import { createUsageRepo } from "./usage.ts";

/** The URL as it may be shown: host and database, never the password. */
function redacted(url: string): string {
  try {
    const u = new URL(url);
    if (u.password !== "") u.password = "***";
    return u.toString();
  } catch {
    return "postgres://<unparseable>";
  }
}

/**
 * A store over a Postgres pool.
 *
 * No handle indirection, unlike the SQLite store: there is no file to swap
 * underneath the repos, so `reopen` has nothing to do and the repos are bound
 * once. Routing subscribers are in-process, exactly as on SQLite — a change
 * another replica commits reaches this one through `routing.version()`, and
 * the fast path the spec describes (`coord.pubsub`) is the gateway's to wire.
 */
export async function createPostgresStore(opts: {
  url: string;
  encryptionKey: CryptoKey;
  logger?: Logger;
  /** This process's identity on `request_logs.node_id`. Fresh per boot when absent. */
  nodeId?: string;
}): Promise<Store> {
  const logger = opts.logger ?? noopLogger;
  const nodeId = opts.nodeId ?? crypto.randomUUID();
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

  const sql = await openPg(opts.url);
  logger.debug("store opened", { path: redacted(opts.url) });

  /**
   * `version()` is synchronous on the interface and a Postgres read is not, so
   * this is read-behind: each call returns the last value fetched and starts
   * the next fetch, one at a time. A change another replica committed is
   * therefore seen by the call *after* the one that raced it — one snapshot
   * check late, never lost, and never a stale value held past the next call.
   */
  // ponytail: read-behind counter; move to a pushed `routing` topic when the
  // one-check lag matters.
  let version = await readVersion();
  let refreshing: Promise<void> | null = null;
  async function readVersion(): Promise<number> {
    const rows = await sql.unsafe<Rows<{ version: string }>>(
      "SELECT version FROM config_version WHERE id = 1",
    );
    return num(rows[0]?.version ?? 0);
  }
  const refresh = (): void => {
    if (refreshing !== null) return;
    refreshing = readVersion()
      .then((next) => {
        version = next;
      })
      .catch(() => {
        // A failed read keeps the last value; the next call retries.
      })
      .finally(() => {
        refreshing = null;
      });
  };

  return {
    engine: "postgres",
    databasePath: redacted(opts.url),
    credentials: createCredentialRepo(sql, opts.encryptionKey, emit),
    config: createConfigRepo(sql, emit),
    // The one repo handed the logger: an unreadable `limits` column is
    // reported rather than thrown, so this is where that trail is written.
    keys: createKeyRepo(sql, logger),
    usage: createUsageRepo(sql, nodeId),
    bodies: createBodyRepo(sql, opts.encryptionKey),
    maintenance: createMaintenanceRepo(sql, nodeId),
    plugins: createPluginRepo(sql),
    routing: {
      version: () => {
        refresh();
        return version;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    async reopen() {
      // Nothing to reopen: the pool is the connection, and there is no file a
      // restore could have replaced underneath it.
    },
    close: () => {
      void sql.close();
    },
  };
}
