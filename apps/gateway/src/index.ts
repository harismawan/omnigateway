import { createStore, deriveKey } from "@omni/store";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { startMaintenance } from "./maintenance.ts";

const config = loadConfig(process.env);
const encryptionKey = await deriveKey(config.encryptionKey);

const store = await createStore({
  path: config.databasePath,
  encryptionKey,
});

const app = createApp({ store, baseUrl: config.baseUrl });
const stopMaintenance = startMaintenance({ store, now: () => Date.now() });

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
    void app.stop().then(
      () => exitAfterClosingStore(0),
      () => exitAfterClosingStore(1),
    );
  });
}
