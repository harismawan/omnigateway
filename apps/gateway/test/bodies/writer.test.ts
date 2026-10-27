import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { deriveKey } from "@omni/store";
import { readArtifact } from "../../../../packages/store/src/bodies/artifact.ts";
import type { WorkerMessage } from "../../src/bodies/protocol.ts";
import { createBodyWriter } from "../../src/bodies/seal.ts";
import { spawnBodyWriter } from "../../src/bodies/spawn.ts";

test("the actual worker transport transfers and detaches slice ArrayBuffers", async () => {
  const worker = spawnBodyWriter({
    databasePath: "/tmp/opencode/transport.sqlite",
    databaseUrl: null,
    encryptionKey: "transport-key",
  });
  const ack = new Promise<WorkerMessage>((resolve) => worker.onMessage(resolve));
  const bytes = new TextEncoder().encode("raw text").buffer;
  try {
    worker.post({
      type: "part",
      requestId: "transfer",
      generation: 7,
      part: "client.request",
      seq: 0,
      last: true,
      bytes,
    });
    expect(bytes.byteLength).toBe(0);
    expect(await ack).toEqual({
      type: "slice-ack",
      requestId: "transfer",
      generation: 7,
      bytes: 8,
    });
  } finally {
    worker.terminate();
  }
});

test("SQLite stages until publish-ok, then publishes readable masked raw texts without opening SQLite", async () => {
  const dir = await mkdtemp("/tmp/opencode/body-writer-");
  const key = await deriveKey("writer-test-secret");
  const replies: WorkerMessage[] = [];
  const writer = createBodyWriter({ dir, key, post: (m) => replies.push(m) });
  const main = new Database(join(dir, "main.sqlite"));
  main.run("CREATE TABLE sentinel (value TEXT)");
  const version = main
    .query<{ data_version: number }, []>("PRAGMA data_version")
    .get()?.data_version;
  try {
    const bytes = new TextEncoder().encode('{"prompt":"hi"}').buffer;
    await writer.handle({
      type: "part",
      requestId: "req",
      generation: 0,
      part: "client.request",
      seq: 0,
      last: true,
      bytes,
    });
    const writing = writer.handle({
      type: "meta",
      requestId: "req",
      generation: 0,
      at: 1000,
      error: null,
      client: { truncated: false, responseFrames: false },
      attempts: [],
      abandoned: null,
    });
    while (!replies.some((m) => m.type === "publishing")) await Bun.sleep(1);
    expect((await readdir(dir)).filter((name) => name !== "main.sqlite")).toEqual([".staging"]);
    expect(await readdir(join(dir, ".staging"))).toHaveLength(1);
    await writer.handle({
      type: "publish-ok",
      requestId: "req",
      relPath: "1970/01/01/req.json.enc",
    });
    while (!replies.some((m) => m.type === "written")) await Bun.sleep(1);
    const written = replies.find((m) => m.type === "written");
    expect(written?.type).toBe("written");
    if (written?.type !== "written") throw new Error("missing write");
    const read = await readArtifact(key, dir, written.relPath, written.sha256);
    expect(read.ok && read.artifact.client.request).toEqual({ prompt: "hi" });
    expect(replies[0]).toEqual({
      type: "slice-ack",
      requestId: "req",
      generation: 0,
      bytes: bytes.byteLength,
    });
    await writer.handle({ type: "publish-result", requestId: "req", accepted: true });
    await writing;
    expect(
      main.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version,
    ).toBe(version);
  } finally {
    main.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("refused publication removes the renamed SQLite file before cleanup acknowledgement", async () => {
  const dir = await mkdtemp("/tmp/opencode/body-refusal-");
  const replies: WorkerMessage[] = [];
  const writer = createBodyWriter({
    dir,
    key: await deriveKey("test"),
    post: (m) => replies.push(m),
  });
  try {
    const writing = writer.handle({
      type: "meta",
      requestId: "refused",
      generation: 0,
      at: 1000,
      client: { truncated: false, responseFrames: false },
      attempts: [],
      error: null,
      abandoned: "backlog",
    });
    while (!replies.some((m) => m.type === "publishing")) await Bun.sleep(1);
    await writer.handle({
      type: "publish-ok",
      requestId: "refused",
      relPath: "1970/01/01/refused.json.enc",
    });
    while (!replies.some((m) => m.type === "written")) await Bun.sleep(1);
    const file = Bun.file(join(dir, "1970/01/01/refused.json.enc"));
    expect(await file.exists()).toBe(true);
    await writer.handle({ type: "publish-result", requestId: "refused", accepted: false });
    await writing;
    expect(await Bun.file(join(dir, "1970/01/01/refused.json.enc")).exists()).toBe(false);
    expect(replies.at(-1)?.type).toBe("cleaned");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
