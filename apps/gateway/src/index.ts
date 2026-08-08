import { resolve } from "node:path";
import { createRefresher, loadConfig, OAUTH_PROVIDERS } from "@omni/control";
import { nodeHttpClient } from "@omni/providers";
import { createStore, deriveKey } from "@omni/store";
import { createApp } from "./app.ts";
import { startMaintenance } from "./maintenance.ts";
import { startRefreshScheduler } from "./oauth/scheduler.ts";
import { startQuotaPoller } from "./quota/poller.ts";

const config = loadConfig(process.env);
const encryptionKey = await deriveKey(config.encryptionKey);

const store = await createStore({
  path: config.databasePath,
  encryptionKey,
});

/**
 * One refresher for the whole process, shared by the request path and both
 * background loops. Its per-credential coalescing is what keeps a sweep and a
 * live request from running two refreshes against a provider that rotates
 * refresh tokens, which would invalidate every rotation but the last.
 */
const now = () => Date.now();
const http = nodeHttpClient();
const refresh = createRefresher({ store, providers: OAUTH_PROVIDERS, http, now });

const app = createApp({
  store,
  baseUrl: config.baseUrl,
  http,
  now,
  refresh,
  staticDir: resolve(import.meta.dir, "../../dashboard/dist"),
});

const stopMaintenance = startMaintenance({ store, now });
const stopRefreshScheduler = startRefreshScheduler({ store, refresh, now });
const stopQuotaPoller = await startQuotaPoller({
  store,
  providers: OAUTH_PROVIDERS,
  http,
  refresh,
  now,
});

app.listen({ port: config.port, hostname: config.host });

console.log(`omnigateway listening on http://${config.host}:${config.port}`);

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

    shuttingDown = true;
    stopMaintenance();
    stopRefreshScheduler();
    stopQuotaPoller();
    void app.stop().then(
      () => exitAfterClosingStore(0),
      () => exitAfterClosingStore(1),
    );
  });
}
