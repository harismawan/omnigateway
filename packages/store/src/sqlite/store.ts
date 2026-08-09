import { type Logger, noopLogger } from "@omni/ir";
import type { RoutingChange, Store } from "../types.ts";
import { createConfigRepo } from "./config.ts";
import { createCredentialRepo } from "./credentials.ts";
import { openDb } from "./db.ts";
import { createKeyRepo } from "./keys.ts";
import { createUsageRepo } from "./usage.ts";

export async function createStore(opts: {
  path: string;
  encryptionKey: CryptoKey;
  logger?: Logger;
}): Promise<Store> {
  const logger = opts.logger ?? noopLogger;
  const db = openDb(opts.path);
  logger.debug("store opened", { path: opts.path });
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

  return {
    credentials: createCredentialRepo(db, opts.encryptionKey, emit),
    config: createConfigRepo(db, emit),
    keys: createKeyRepo(db),
    usage: createUsageRepo(db),
    routing: {
      version: () =>
        db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    close: () => db.close(),
  };
}
