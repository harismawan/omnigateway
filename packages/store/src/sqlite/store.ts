import type { Store } from "../types.ts";
import { createConfigRepo } from "./config.ts";
import { createCredentialRepo } from "./credentials.ts";
import { openDb } from "./db.ts";
import { createKeyRepo } from "./keys.ts";
import { createUsageRepo } from "./usage.ts";

export async function createStore(opts: {
  path: string;
  encryptionKey: CryptoKey;
}): Promise<Store> {
  const db = openDb(opts.path);
  return {
    credentials: createCredentialRepo(db, opts.encryptionKey),
    config: createConfigRepo(db),
    keys: createKeyRepo(db),
    usage: createUsageRepo(db),
    close: () => db.close(),
  };
}
