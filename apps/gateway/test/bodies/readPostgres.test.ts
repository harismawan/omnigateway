import { expect, test } from "bun:test";
import { createPostgresStore, deriveKey } from "@omni/store";
import type { WorkerMessage } from "../../src/bodies/protocol.ts";
import { spawnBodyWriter } from "../../src/bodies/spawn.ts";

const url = process.env.OMNI_TEST_DATABASE_URL;
test.skipIf(!url)(
  "real body worker reads Postgres bytea through its own pool across pause/resume",
  async () => {
    if (!url) throw new Error("Postgres URL required");
    const store = await createPostgresStore({
      url,
      encryptionKey: await deriveKey("pg-reader"),
    });
    const id = `reader-${crypto.randomUUID()}`;
    await store.bodies.put({
      schemaVersion: 1,
      requestId: id,
      at: 1,
      client: { request: { text: "postgres" }, response: null, truncated: false },
      attempts: [],
      error: null,
    });
    const worker = spawnBodyWriter({
      databasePath: null,
      databaseUrl: url,
      encryptionKey: "pg-reader",
    });
    let reply = Promise.withResolvers<WorkerMessage>();
    worker.onMessage((m) => reply.resolve(m));
    try {
      worker.post({ type: "read", requestId: id, ref: 1 });
      const first = await reply.promise;
      expect(first.type).toBe("read-result");
      if (first.type === "read-result")
        expect(first.preview.parts[0]?.preview).toBe('{"text":"postgres"}');
      reply = Promise.withResolvers<WorkerMessage>();
      worker.post({ type: "pause" });
      expect((await reply.promise).type).toBe("paused");
      worker.post({ type: "resume" });
      reply = Promise.withResolvers<WorkerMessage>();
      worker.post({ type: "readRaw", requestId: id, part: "client.request", ref: 2 });
      expect((await reply.promise).type).toBe("raw-ready");
      reply = Promise.withResolvers<WorkerMessage>();
      worker.post({ type: "read-pull", ref: 2 });
      const raw = await reply.promise;
      expect(raw.type).toBe("raw-chunk");
      if (raw.type === "raw-chunk")
        expect(new TextDecoder().decode(raw.bytes)).toBe('{"text":"postgres"}');
    } finally {
      worker.terminate();
      store.close();
    }
  },
);
