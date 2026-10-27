// Manual two-process RSS probe: prepare separately so setup peak is not read peak.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { noopLogger } from "@omni/ir";
import { createStore, deriveKey } from "@omni/store";
import { requestLog } from "@omni/testkit";
import { sha256Hex } from "../../../../../packages/store/src/bodies/artifact.ts";
import { createCaptureBudget } from "../../../src/bodies/budget.ts";
import { createBodyWriterHost } from "../../../src/bodies/host.ts";
import { spawnBodyWriter } from "../../../src/bodies/spawn.ts";

const root = process.argv[3];
if (!root) throw new Error("usage: readMemoryProbe.ts prepare|read ROOT");
const path = join(root, "main.sqlite");
const key = await deriveKey("memory-probe");
const store = await createStore({ path, encryptionKey: key });
if (process.argv[2] === "prepare") {
  const row = await store.bodies.put({
    schemaVersion: 1,
    requestId: "legacy",
    at: 1,
    client: { request: null, response: null, truncated: false },
    attempts: [],
    error: null,
  });
  const json = JSON.stringify({
    schemaVersion: 1,
    requestId: "legacy",
    at: 1,
    client: { request: " ".repeat(60 * 1024 * 1024), response: null, truncated: false },
    attempts: [],
    error: null,
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(json)),
  );
  const bytes = Buffer.from(
    `enc:v1:${Buffer.from(iv).toString("hex")}:${Buffer.from(sealed.subarray(0, -16)).toString("hex")}:${Buffer.from(sealed.subarray(-16)).toString("hex")}`,
  );
  if (!row.relPath) throw new Error("missing path");
  await Bun.write(join(root, "request_bodies", row.relPath), bytes);
  const db = new Database(path);
  db.run("UPDATE request_bodies SET sha256 = ?, size_bytes = ? WHERE request_id = ?", [
    await sha256Hex(bytes),
    bytes.length,
    "legacy",
  ]);
  db.close();
  console.log(`prepared plaintext=${Buffer.byteLength(json)} envelope=${bytes.length}`);
} else {
  const budget = createCaptureBudget(128 * 1024 * 1024);
  const writeId = `overlap-${crypto.randomUUID()}`;
  // A live collector's retained text, separate from a concurrently submitted write.
  const retained = " retained ".repeat(Math.ceil((32 * 1024 * 1024) / 10));
  budget.reserve(Buffer.byteLength(retained));
  const text = JSON.stringify(" write ".repeat(Math.ceil((16 * 1024 * 1024) / 7)));
  budget.reserve(Buffer.byteLength(text));
  await store.usage.begin({
    ...requestLog({ id: writeId }),
    state: "pending",
    bodyState: "pending",
  });
  const host = createBodyWriterHost({
    spawn: () =>
      spawnBodyWriter({ databasePath: path, databaseUrl: null, encryptionKey: "memory-probe" }),
    bodies: store.bodies,
    budget,
    logger: noopLogger,
    now: Date.now,
    timers: { setTimeout, clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
  });
  await host.start();
  const reading = host.read("legacy");
  host.enqueue({
    requestId: writeId,
    at: 1,
    client: { request: text, response: null, truncated: false },
    attempts: [],
    error: null,
    abandoned: null,
    reservedBytes: Buffer.byteLength(text),
  });
  const response = await new Response(await reading).text();
  for (let i = 0; i < 400 && (await store.usage.get(writeId))?.bodyState === "pending"; i++)
    await Bun.sleep(10);
  console.log(
    `previewBytes=${Buffer.byteLength(response)} retainedBytes=${Buffer.byteLength(retained)} writeState=${(await store.usage.get(writeId))?.bodyState} budgetHeld=${budget.held()}`,
  );
  await host.halt();
  host.stop();
}
store.close();
