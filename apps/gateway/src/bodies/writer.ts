import { workerData } from "node:worker_threads";
import { SQL } from "bun";
import { bodiesDirFor } from "../../../../packages/store/src/bodies/artifact.ts";
import { deriveKey } from "../../../../packages/store/src/encryption.ts";
import { createBodyRepo } from "../../../../packages/store/src/postgres/bodies.ts";
import type { BodyWriterInit, MainMessage, WorkerMessage } from "./protocol.ts";
import { createBodyWriter } from "./seal.ts";

declare const self: {
  postMessage(message: WorkerMessage): void;
  onmessage: ((event: MessageEvent<MainMessage>) => void) | null;
};

const init = workerData as BodyWriterInit;
const early: MainMessage[] = [];
self.onmessage = (event) => {
  early.push(event.data);
};
const key = await deriveKey(init.encryptionKey);
// SQL reconnects lazily after pause closes the small pool.
let sql: SQL | null = null;
const writer = createBodyWriter({
  key,
  dir: init.databasePath === null ? null : bodiesDirFor(init.databasePath),
  bodies: {
    writeRow: async (row) => {
      sql ??= new SQL({ url: init.databaseUrl ?? "", max: 2 });
      return createBodyRepo(sql, key).writeRow(row);
    },
  },
  post: (message) => self.postMessage(message),
  close: async () => {
    await sql?.close();
    sql = null;
  },
});
// New instances start only after old-thread closure. Clean abandoned staging
// before accepting early messages too (the previous pause may have timed out).
await writer.handle({ type: "resume" });
function handle(message: MainMessage): void {
  void writer
    .handle(message)
    .then(() => {
      if (message.type === "stop") process.exit(0);
    })
    .catch(() => process.exit(1));
}
self.onmessage = (event) => handle(event.data);
for (const message of early) handle(message);
