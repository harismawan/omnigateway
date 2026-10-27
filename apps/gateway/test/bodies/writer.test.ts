import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveKey } from "@omni/store";
import { readArtifact } from "../../../../packages/store/src/bodies/artifact.ts";
import type { BodyMeta, WorkerMessage } from "../../src/bodies/protocol.ts";
import { createBodyWriter } from "../../src/bodies/seal.ts";
import { spawnBodyWriter } from "../../src/bodies/spawn.ts";

test("a newer pause fences pending resume cleanup and waiting admission until valid recovery", async () => {
  const replies: WorkerMessage[] = [];
  let writes = 0;
  const writer = createBodyWriter({
    dir: null,
    key: await deriveKey("overlap"),
    bodies: {
      writeRow: async () => {
        writes++;
        return false;
      },
    },
    post: (m) => replies.push(m),
  });
  const resume = writer.handle({ type: "resume" });
  const waitingPart = writer.handle({
    type: "part",
    requestId: "old",
    generation: 0,
    part: "client.request",
    seq: 0,
    last: true,
    bytes: new TextEncoder().encode("old").buffer,
  });
  const meta: BodyMeta = {
    type: "meta",
    requestId: "old",
    generation: 0,
    at: 1000,
    error: null,
    client: { truncated: false, responseFrames: false },
    attempts: [],
    abandoned: null,
  };
  const waitingMeta = writer.handle(meta);
  const pause = writer.handle({ type: "pause" });
  await Promise.all([resume, waitingPart, waitingMeta, pause]);
  expect(replies).toEqual([{ type: "paused" }]);
  await writer.handle(meta);
  expect(writes).toBe(0);
  await writer.handle({ type: "resume" });
  await writer.handle({ ...meta, requestId: "new", generation: 1 });
  expect(writes).toBe(1);
  expect(replies.at(-1)).toEqual({ type: "unowned", requestId: "new", generation: 1 });
});

test("resume cleans fresh stale staging only after the active write and handles quiesce", async () => {
  const dir = await mkdtemp("/tmp/opencode/body-resume-");
  const key = await deriveKey("resume-test");
  const closed = Promise.withResolvers<void>();
  let closing = false;
  const writer = createBodyWriter({
    dir,
    key,
    post: () => {},
    close: async () => {
      closing = true;
      await closed.promise;
    },
  });
  await mkdir(join(dir, ".staging"));
  const path = join(dir, ".staging", "fresh.old");
  await writeFile(path, "old database");
  const pausing = writer.handle({ type: "pause" });
  await Bun.sleep(1);
  expect(closing).toBe(true);
  expect(await readdir(join(dir, ".staging"))).toEqual(["fresh.old"]);
  closed.resolve();
  await pausing;
  await writer.handle({ type: "resume" });
  expect(await readdir(join(dir, ".staging"))).toEqual([]);
  await rm(dir, { recursive: true, force: true });
});

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

test("a paused real writer exits on stop and reports actual thread closure", async () => {
  const root = await mkdtemp("/tmp/opencode/body-close-");
  const worker = spawnBodyWriter({
    databasePath: join(root, "main.sqlite"),
    databaseUrl: null,
    encryptionKey: "close-key",
  });
  const paused = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  worker.onMessage((m) => {
    if (m.type === "paused") paused.resolve();
  });
  worker.onExit(() => closed.resolve());
  try {
    worker.post({ type: "pause" });
    await paused.promise;
    let exited = false;
    void closed.promise.then(() => {
      exited = true;
    });
    await Bun.sleep(1);
    expect(exited).toBe(false); // ACK closes handles, not the thread.
    worker.post({ type: "stop" });
    await closed.promise;
  } finally {
    worker.terminate();
    await rm(root, { recursive: true, force: true });
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
