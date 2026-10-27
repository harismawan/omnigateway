import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { noopLogger } from "@omni/ir";
import { createStore, deriveKey } from "@omni/store";
import { requestLog } from "@omni/testkit";
import { sha256Hex } from "../../../../packages/store/src/bodies/artifact.ts";
import { encrypt } from "../../../../packages/store/src/encryption.ts";
import { createCaptureBudget } from "../../src/bodies/budget.ts";
import { createBodyWriterHost } from "../../src/bodies/host.ts";
import { spawnBodyWriter } from "../../src/bodies/spawn.ts";

test("real worker decrypts previews off-main and streams exact JSON with bounded pulls and cancellation", async () => {
  const root = await mkdtemp("/tmp/opencode/body-read-");
  const path = join(root, "main.sqlite");
  const secret = "reader-test";
  const store = await createStore({ path, encryptionKey: await deriveKey(secret) });
  const text = "é🙂 ".repeat(250_000);
  const json = JSON.stringify(text);
  await store.bodies.put({
    schemaVersion: 1,
    requestId: "read",
    at: 1,
    client: { request: text, response: { ok: true }, truncated: false },
    attempts: [],
    error: null,
  });
  const budget = createCaptureBudget(1024);
  const host = createBodyWriterHost({
    spawn: () => spawnBodyWriter({ databasePath: path, databaseUrl: null, encryptionKey: secret }),
    bodies: store.bodies,
    budget,
    logger: noopLogger,
    now: Date.now,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
  });
  const parse = JSON.parse;
  const decrypt = crypto.subtle.decrypt;
  try {
    await host.start();
    JSON.parse = (value, reviver) => {
      if (Buffer.byteLength(value) > 1024 * 1024) throw new Error("main parsed large body");
      return parse(value, reviver);
    };
    crypto.subtle.decrypt = () => {
      throw new Error("main decrypted body");
    };
    store.bodies.get = () => {
      throw new Error("main read envelope");
    };
    const preview = await host.read("read");
    expect(preview.parts[0]?.sizeBytes).toBe(Buffer.byteLength(json));
    expect(preview.parts[0]?.previewTruncated).toBe(true);
    expect(Buffer.byteLength(preview.parts[0]?.preview ?? "")).toBeLessThanOrEqual(1024 * 1024);
    expect(json.startsWith(preview.parts[0]?.preview ?? "")).toBe(true);
    const stream = await host.readRaw("read", "client.request");
    expect(stream).not.toBeNull();
    if (!stream) throw new Error("raw part missing");
    const reader = stream.getReader();
    let result = "";
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      expect(chunk.value.byteLength).toBeLessThanOrEqual(1024 * 1024);
      result += decoder.decode(chunk.value, { stream: true });
    }
    result += decoder.decode();
    expect(result).toBe(json);
    const cancel = await host.readRaw("read", "client.request");
    // A client that does not pull raw bytes must not hold the capture chain.
    await store.usage.begin({
      ...requestLog({ id: "during-download" }),
      state: "pending",
      bodyState: "pending",
    });
    budget.reserve(2);
    host.enqueue({
      requestId: "during-download",
      at: 1,
      client: { request: "{}", response: null, truncated: false },
      attempts: [],
      error: null,
      abandoned: null,
      reservedBytes: 2,
    });
    for (
      let i = 0;
      i < 200 && (await store.usage.get("during-download"))?.bodyState === "pending";
      i++
    )
      await Bun.sleep(5);
    expect((await store.usage.get("during-download"))?.bodyState).toBe("ready");
    await expect(host.read("read")).rejects.toThrow("unavailable");
    if (!cancel) throw new Error("raw part missing");
    await cancel.cancel();
    expect((await host.read("read")).detailState).toBe("ready");
    const paused = await host.readRaw("read", "client.request");
    await host.pause();
    if (!paused) throw new Error("raw part missing");
    await expect(paused.getReader().read()).rejects.toThrow("unavailable");
    await host.resume(true);
    expect((await host.read("read")).detailState).toBe("ready");
  } finally {
    JSON.parse = parse;
    crypto.subtle.decrypt = decrypt;
    await host.halt();
    host.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("the actual worker previews legacy hex artifacts and old omission markers", async () => {
  const root = await mkdtemp("/tmp/opencode/body-legacy-read-");
  const path = join(root, "main.sqlite");
  const key = await deriveKey("legacy-reader");
  const store = await createStore({ path, encryptionKey: key });
  const marker = {
    omitted: true as const,
    reason: "artifact exceeded 524288 bytes after structural bounding",
    serializedBytes: 900_000,
  };
  const artifact = {
    schemaVersion: 1,
    requestId: "legacy",
    at: 1,
    client: { request: marker, response: "old response", truncated: true },
    attempts: [],
    error: null,
  };
  const row = await store.bodies.put(artifact);
  const bytes = new TextEncoder().encode(await encrypt(key, JSON.stringify(artifact)));
  if (!row.relPath) throw new Error("missing artifact path");
  await writeFile(join(root, "request_bodies", row.relPath), bytes);
  const db = new Database(path);
  db.run("UPDATE request_bodies SET sha256 = ?, size_bytes = ? WHERE request_id = ?", [
    await sha256Hex(bytes),
    bytes.length,
    "legacy",
  ]);
  db.close();
  const worker = spawnBodyWriter({
    databasePath: path,
    databaseUrl: null,
    encryptionKey: "legacy-reader",
  });
  try {
    const response = Promise.withResolvers<import("../../src/bodies/protocol.ts").WorkerMessage>();
    worker.onMessage((m) => {
      if ("ref" in m) response.resolve(m);
    });
    worker.post({ type: "read", ref: 1, requestId: "legacy" });
    const message = await response.promise;
    expect(message.type).toBe("read-result");
    if (message.type !== "read-result") throw new Error("no preview");
    expect(message.preview.parts[0]?.omitted).toEqual(marker);
    expect(message.preview.parts[1]?.preview).toBe('"old response"');
    expect(message.preview.truncated).toBe(true);
  } finally {
    worker.terminate();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("near-cap legacy envelope decoding stays in the bounded real-worker read slot", async () => {
  const root = await mkdtemp("/tmp/opencode/body-legacy-cap-");
  const path = join(root, "main.sqlite");
  const key = await deriveKey("legacy-cap");
  const store = await createStore({ path, encryptionKey: key });
  const row = await store.bodies.put({
    schemaVersion: 1,
    requestId: "large",
    at: 1,
    client: { request: null, response: null, truncated: false },
    attempts: [],
    error: null,
  });
  const value = " ".repeat(60 * 1024 * 1024);
  const json = JSON.stringify({
    schemaVersion: 1,
    requestId: "large",
    at: 1,
    client: { request: value, response: null, truncated: false },
    attempts: [],
    error: null,
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(json)),
  );
  const envelope = Buffer.from(
    `enc:v1:${Buffer.from(iv).toString("hex")}:${Buffer.from(sealed.subarray(0, -16)).toString("hex")}:${Buffer.from(sealed.subarray(-16)).toString("hex")}`,
  );
  if (!row.relPath) throw new Error("missing path");
  await writeFile(join(root, "request_bodies", row.relPath), envelope);
  const db = new Database(path);
  db.run("UPDATE request_bodies SET sha256 = ?, size_bytes = ? WHERE request_id = ?", [
    await sha256Hex(envelope),
    envelope.length,
    "large",
  ]);
  db.close();
  const worker = spawnBodyWriter({
    databasePath: path,
    databaseUrl: null,
    encryptionKey: "legacy-cap",
  });
  try {
    const reply = Promise.withResolvers<import("../../src/bodies/protocol.ts").WorkerMessage>();
    worker.onMessage((message) => reply.resolve(message));
    worker.post({ type: "read", requestId: "large", ref: 1 });
    const message = await reply.promise;
    expect(message.type).toBe("read-result");
    if (message.type !== "read-result") throw new Error("no preview");
    expect(message.preview.parts[0]?.sizeBytes).toBe(60 * 1024 * 1024 + 2);
    expect(message.preview.parts[0]?.previewTruncated).toBe(true);
    expect(Buffer.byteLength(message.preview.parts[0]?.preview ?? "")).toBe(1024 * 1024);
  } finally {
    worker.terminate();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
