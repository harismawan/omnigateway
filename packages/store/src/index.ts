export {
  ARTIFACT_SCHEMA_VERSION,
  BODIES_DIRNAME,
  BODY_ROW_CAP,
  bodiesDirFor,
  MAX_ARTIFACT_BYTES,
} from "./bodies/artifact.ts";
export {
  MAX_ARRAY_ITEMS,
  MAX_DEPTH,
  MAX_OBJECT_KEYS,
  MAX_STRING_BYTES,
} from "./bodies/bound.ts";
export * from "./encryption.ts";
export { createPostgresStore } from "./postgres/store.ts";
export { createBodyRepo } from "./sqlite/bodies.ts";
export { createConfigRepo } from "./sqlite/config.ts";
export { createCredentialRepo } from "./sqlite/credentials.ts";
export { openDb } from "./sqlite/db.ts";
export { createKeyRepo, generateApiKey, hashApiKey } from "./sqlite/keys.ts";
export { createMaintenanceRepo } from "./sqlite/maintenance.ts";
export { createPluginRepo } from "./sqlite/plugins.ts";
export { createStore } from "./sqlite/store.ts";
export { createUsageRepo } from "./sqlite/usage.ts";
export * from "./types.ts";

import type { Logger } from "@omni/ir";
import { createPostgresStore as postgres } from "./postgres/store.ts";
import { createStore as sqlite } from "./sqlite/store.ts";
import type { Store } from "./types.ts";

/**
 * One store, chosen by how it is named: a `url` is a Postgres pool, a `path`
 * is a SQLite file. The two factories stay exported for callers that already
 * know which they hold; this is for the boot path, which reads one setting.
 */
export function openStore(
  opts: { encryptionKey: CryptoKey; logger?: Logger; nodeId?: string } & (
    | { url: string; path?: undefined }
    | { path: string; url?: undefined }
  ),
): Promise<Store> {
  return opts.url === undefined ? sqlite(opts) : postgres(opts);
}
