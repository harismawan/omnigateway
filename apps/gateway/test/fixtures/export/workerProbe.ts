/**
 * Spawns the export worker exactly as the gateway does — `spawnExportWorker`,
 * with the build's `OMNI_EXPORT_WORKER` — asks it for a preview it cannot
 * find, and prints the reply. A build that left the worker out prints the
 * worker's death instead. Used by `scripts/test/build-npm.test.ts` and
 * `build-binary.test.ts`; never shipped.
 */
import { createStore, deriveKey } from "@omni/store";
import { spawnBodyWriter } from "../../../src/bodies/spawn.ts";
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
const bodyWriter = spawnBodyWriter({ databasePath, databaseUrl: null, encryptionKey: KEY });
let exportReply: unknown;
let bodyPaused = false;
function finish(): void {
  if (exportReply === undefined || !bodyPaused) return;
  console.log(JSON.stringify(exportReply));
  clearTimeout(timer);
  worker.terminate();
  bodyWriter.terminate();
  process.exit(0);
}
bodyWriter.onExit(() => {
  console.log("body writer died");
  process.exit(1);
});
bodyWriter.onMessage((message) => {
  if (message.type !== "paused") return;
  bodyPaused = true;
  finish();
});
bodyWriter.post({ type: "pause" });
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
  exportReply = message;
  finish();
});
worker.post({ type: "preview", ref: "probe", requestId: "req_missing" });
