import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, deriveKey } from "@omni/store";
import {
  memoryStore,
  requestLog,
  seedApiKey,
  seedCredential,
  target,
  virtualModel,
} from "@omni/testkit";
import { copyStore } from "../src/copyStore.ts";

/**
 * A copy between two stores through the interface alone. SQLite to SQLite
 * here, which is the same code path as SQLite to Postgres — the contract
 * suite proves `importRow`, `scan` and `append` agree on both backends.
 */
test("copies configuration, credentials, keys and completed logs into an empty store", async () => {
  const source = await memoryStore();
  const target_ = await memoryStore();
  await source.config.setAdminPasswordHash("$argon2id$hash");
  await source.config.putSettings({ ponytailMode: "lite" });
  await seedCredential(source, { id: "c1", label: "work", accessToken: "test-token-1" });
  await source.config.putModel(
    virtualModel({ id: "fast", targets: [target({ provider: "anthropic", model: "m" })] }),
  );
  const { key } = await seedApiKey(source, { limits: { concurrency: 1 } });
  await source.keys.revoke(key.id);
  await source.usage.append(requestLog({ id: "r1", apiKeyId: key.id, at: 1_700_000_000_000 }));
  await source.usage.begin(
    requestLog({ id: "r2", apiKeyId: key.id, at: 1_700_000_000_001, state: "pending" }),
  );

  await source.exportDestinations.create({
    id: "hook",
    type: "webhook",
    config: { url: "https://hook.example" },
    filter: { failedOnly: true },
    enabled: false,
    maxRequestBytes: 2_048,
    secret: "signing-secret",
    startFrom: "oldest",
  });

  const report = await copyStore(source, target_);
  expect(report.counts).toEqual({
    credentials: 1,
    apiKeys: 1,
    models: 1,
    requestLogs: 1,
    skippedPending: 1,
    exportDestinations: 1,
  });
  expect(report.notCarried.length).toBeGreaterThan(0);

  expect(await target_.config.getAdminPasswordHash()).toBe("$argon2id$hash");
  expect((await target_.config.getSettings()).ponytailMode).toBe("lite");
  const credential = await target_.credentials.get("c1");
  expect(credential?.label).toBe("work");
  expect((await credential?.secrets())?.accessToken).toBe("test-token-1");
  expect((await target_.config.listModels()).map((m) => m.id)).toEqual(["fast"]);
  const copied = await target_.keys.get(key.id);
  expect(copied?.hash).toBe(key.hash);
  expect(copied?.revokedAt).not.toBeNull();
  expect((await target_.usage.recent(10)).map((row) => row.id)).toEqual(["r1"]);
  expect((await target_.usage.sumSince(key.id, 0)).requests).toBe(1);

  // A destination arrives with its configuration and secret, but as a new
  // destination: export state is not carried, so it starts at the copy's tail
  // rather than re-sending every copied row.
  const [hook] = await target_.exportDestinations.list();
  const [original] = await source.exportDestinations.list();
  expect(hook).toMatchObject({
    id: "hook",
    type: "webhook",
    config: { url: "https://hook.example" },
    filter: { failedOnly: true },
    enabled: false,
    maxRequestBytes: 2_048,
    hasSecret: true,
  });
  expect(hook?.generation).not.toBe(original?.generation);
  // The destination's initial cursor is `(startAt, '')`, and nothing copied is
  // ahead of it — not even a row stamped in the same millisecond.
  const [copiedLog] = await target_.usage.recent(1);
  expect(hook?.startAt).toBeGreaterThan(copiedLog?.completedAt as number);
  expect(
    await target_.usage.exportPage({
      after: { completedAt: hook?.startAt as number, id: "" },
      settledBefore: Number.MAX_SAFE_INTEGER,
      limit: 10,
    }),
  ).toEqual([]);
  expect(await target_.exportDestinations.openSecret("hook")).toBe("signing-secret");
  expect(report.notCarried.some((line) => line.startsWith("export state"))).toBe(true);

  // A second copy is refused: the target is no longer empty.
  await expect(copyStore(source, target_)).rejects.toThrow("already holds data");
  source.close();
  target_.close();
});

/**
 * Bodies are the one corpus a copy leaves behind, whatever envelope the source
 * stored them in: the report says so, and the target holds no row for them.
 */
test("a copy leaves request bodies with the source and says so", async () => {
  const root = join(tmpdir(), `omni-copy-bodies-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const source = await createStore({
    path: join(root, "source.db"),
    encryptionKey: await deriveKey("test-encryption-key-0123456789"),
  });
  const target_ = await memoryStore();
  try {
    await source.bodies.put({
      schemaVersion: 1,
      requestId: "req_copy-1",
      at: 1_700_000_000_000,
      client: { request: { q: "kept at the source" }, response: null, truncated: false },
      attempts: [],
      error: null,
    });
    expect((await source.bodies.get("req_copy-1"))?.row.detailState).toBe("ready");

    const report = await copyStore(source, target_);
    expect(report.notCarried.some((line) => line.startsWith("request bodies"))).toBe(true);
    expect(await target_.bodies.get("req_copy-1")).toBeNull();
    expect((await source.bodies.get("req_copy-1"))?.row.detailState).toBe("ready");
  } finally {
    source.close();
    target_.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** The move itself, SQLite onto a real Postgres, when one is to hand. */
const pg = process.env.OMNI_TEST_DATABASE_URL;
if (pg === undefined) {
  test.skip("copies a SQLite store onto Postgres (set OMNI_TEST_DATABASE_URL)", () => {});
} else {
  test("copies a SQLite store onto Postgres", async () => {
    const { SQL } = await import("bun");
    const { createPostgresStore, deriveKey } = await import("@omni/store");
    const admin = new SQL({ url: pg, max: 1 });
    try {
      await admin.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    } finally {
      await admin.close();
    }
    const source = await memoryStore();
    const target_ = await createPostgresStore({
      url: pg,
      encryptionKey: await deriveKey("test-encryption-key-0123456789"),
    });
    await seedCredential(source, { id: "c1", accessToken: "test-token-1" });
    const { key } = await seedApiKey(source, { limits: {} });
    await source.usage.append(requestLog({ id: "r1", apiKeyId: key.id, at: 1_700_000_000_000 }));
    await source.exportDestinations.create({
      id: "es",
      type: "elasticsearch",
      config: { url: "https://es:9200" },
      startFrom: "oldest",
    });

    const report = await copyStore(source, target_);
    // Postgres stamps from its own clock; the boundary must still be past the
    // copied row on that clock.
    const es = await target_.exportDestinations.get("es");
    expect(
      await target_.usage.exportPage({
        after: { completedAt: es?.startAt as number, id: "" },
        settledBefore: Number.MAX_SAFE_INTEGER,
        limit: 10,
      }),
    ).toEqual([]);
    expect(report.counts.credentials).toBe(1);
    expect((await (await target_.credentials.get("c1"))?.secrets())?.accessToken).toBe(
      "test-token-1",
    );
    expect((await target_.keys.get(key.id))?.hash).toBe(key.hash);
    expect((await target_.usage.sumSince(key.id, 0)).requests).toBe(1);
    source.close();
    target_.close();
  });
}
