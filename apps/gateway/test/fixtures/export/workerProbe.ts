/**
 * Spawns the export worker exactly as the gateway does — `spawnExportWorker`,
 * with the build's `OMNI_EXPORT_WORKER` — asks it for a preview it cannot
 * find, and prints the reply. A build that left the worker out prints the
 * worker's death instead. Used by `scripts/test/build-npm.test.ts` and
 * `build-binary.test.ts`; never shipped.
 */
import { createStore, deriveKey } from "@omni/store";
import { spawnExportWorker } from "../../../src/export/spawn.ts";

const KEY = "export-worker-probe-encryption-key";
// A real, migrated installation: the worker opens it read-only and never creates one.
const databasePath = process.argv[2] ?? "";
(await createStore({ path: databasePath, encryptionKey: await deriveKey(KEY) })).close();
const worker = spawnExportWorker({
  databasePath,
  databaseUrl: null,
  encryptionKey: KEY,
  redisUrl: null,
  nodeId: "probe",
  logLevel: "error",
  exportBodiesAllowed: false,
  gates: { bodyLoggingAllowed: false },
});
const timer = setTimeout(() => {
  console.log("timeout");
  process.exit(2);
}, 10_000);
worker.onExit(() => {
  console.log("worker died");
  process.exit(1);
});
worker.onMessage((message) => {
  if (message.type !== "previewResult") return;
  console.log(JSON.stringify(message));
  clearTimeout(timer);
  worker.terminate();
  process.exit(0);
});
worker.post({ type: "preview", ref: "probe", requestId: "req_missing" });
