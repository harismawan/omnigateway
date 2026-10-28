import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinPrompts, resolvePrompts } from "@omni/prompts";
import { createStore, deriveKey, type PromptDetail, type Store } from "@omni/store";
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
    prompts: 0,
    promptVersions: 0,
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

// Active v1 survives pruning; the next save must continue from v102, not the
// retained count. Deliberately distinct timestamps catch save/activate rebuilds.
function retained(id = "team"): PromptDetail {
  return {
    id,
    name: "Team rules",
    description: "Retained history",
    activeVersion: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_102,
    versions: [...Array.from({ length: 99 }, (_, i) => 102 - i), 1].map((version) => ({
      promptId: id,
      version,
      text: `  rules ${version}`,
      note: `note ${version}`,
      createdAt: 1_700_000_000_000 + version,
    })),
  };
}

async function promptCopy(source: Store, target_: Store) {
  const sourceDetail = retained();
  await source.prompts.importRow(sourceDetail);
  await source.prompts.create({
    id: "draft",
    name: "Draft",
    description: null,
    text: "draft text",
    note: null,
    activate: false,
  });
  await source.config.putSettings({ prompts: ["team", "ponytail-lite"] });
  const { key } = await seedApiKey(source, {
    prompts: { ids: ["draft", "team"], inheritGlobal: false },
  });
  await source.usage.append(
    requestLog({ id: "historical", apiKeyId: key.id, prompts: ["team@2", "deleted@1"] }),
  );
  const report = await copyStore(source, target_);
  const copied = await target_.prompts.get("team");
  expect(copied?.versions).toEqual(sourceDetail.versions);
  expect(copied?.activeVersion).toBe(1);
  expect(copied).toEqual(sourceDetail);
  expect(await target_.prompts.get("draft")).toEqual(await source.prompts.get("draft"));
  expect(report.counts.prompts).toBe(2);
  expect(report.counts.promptVersions).toBe(101);
  expect((await target_.config.getSettings()).prompts).toEqual(["team", "ponytail-lite"]);
  expect((await target_.keys.get(key.id))?.prompts).toEqual(key.prompts);
  expect((await target_.usage.get("historical"))?.prompts).toEqual(["team@2", "deleted@1"]);
  expect(await target_.prompts.assignments("team")).toEqual({ global: true, keyIds: [key.id] });
  expect(
    (await target_.prompts.saveVersion("team", { text: "next", note: null, activate: false }))
      .version,
  ).toBe(103);
}

async function promptOnlyTarget(source: Store, target_: Store) {
  await target_.prompts.importRow(retained());
  await source.config.setAdminPasswordHash("must-not-arrive");
  const before = await target_.config.getSettings();
  await expect(copyStore(source, target_)).rejects.toThrow("already holds data");
  expect(await target_.config.getAdminPasswordHash()).toBeNull();
  expect(await target_.config.getSettings()).toEqual(before);
  expect(await target_.prompts.get("team")).toEqual(retained());
}

async function danglingCopy(source: Store, target_: Store) {
  await source.prompts.importRow(retained());
  const { key } = await seedApiKey(source);
  // Model normalized reads from a restored DB: missing IDs are supported stored
  // state, not something an ordinary assignment writer is allowed to introduce.
  const settings = {
    ...(await source.config.getSettings()),
    prompts: ["missing-global", "team", "ponytail-full"],
    ponytailMode: "full" as const,
    logRetentionDays: 1,
    logRetentionLoweredAt: 123,
  };
  const assignment = { ids: ["missing-key", "team", "ponytail-lite"], inheritGlobal: true };
  const restored = {
    ...source,
    config: { ...source.config, getSettings: async () => settings },
    keys: { ...source.keys, list: async () => [{ ...key, prompts: assignment }] },
  };
  // Import must not reconcile source aliases against unrelated target defaults.
  await target_.config.putSettings({ ponytailMode: "ultra" });
  await copyStore(restored, target_);
  expect(await target_.config.getSettings()).toEqual(settings);
  expect((await target_.keys.get(key.id))?.prompts).toEqual(assignment);
  expect(await target_.prompts.get("team")).toEqual(retained());
  const active = new Map(
    [...builtinPrompts(), ...(await target_.prompts.listActive())].map((p) => [p.id, p]),
  );
  const resolved = resolvePrompts(settings.prompts, assignment, active);
  expect(resolved.prompts.map((p) => p.id)).toEqual(["team", "ponytail-lite"]);
  expect(resolved.notes).toContain("prompt:missing");
  await target_.config.putSettings({ prompts: settings.prompts });
  await target_.keys.setPrompts(key.id, assignment);
  await expect(
    target_.config.putSettings({ prompts: [...settings.prompts, "new-missing"] }),
  ).rejects.toMatchObject({ kind: "missing" });
  await expect(
    target_.keys.setPrompts(key.id, { ...assignment, ids: [...assignment.ids, "new-missing"] }),
  ).rejects.toMatchObject({ kind: "missing" });
  await expect(
    target_.keys.importRow({
      ...key,
      id: "ordinary-import",
      hash: "ordinary-import",
      prompts: assignment,
    }),
  ).rejects.toMatchObject({ kind: "missing" });
  await expect(target_.prompts.remove("team")).rejects.toMatchObject({ kind: "assigned" });
}

for (const direction of ["sqlite→sqlite", "sqlite→postgres", "postgres→sqlite"] as const) {
  for (const scenario of [promptCopy, promptOnlyTarget, danglingCopy]) {
    test.skipIf(direction.includes("postgres") && !process.env.OMNI_TEST_DATABASE_URL)(
      `${direction} ${scenario.name}: exact history/counts or prompt-only target preflight`,
      async () => {
        const openPg = async () => {
          const { SQL } = await import("bun");
          const { createPostgresStore } = await import("@omni/store");
          const url = process.env.OMNI_TEST_DATABASE_URL as string;
          const admin = new SQL({ url, max: 1 });
          try {
            await admin.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
          } finally {
            await admin.close();
          }
          return createPostgresStore({
            url,
            encryptionKey: await deriveKey("test-encryption-key-0123456789"),
          });
        };
        const source = direction.startsWith("postgres") ? await openPg() : await memoryStore();
        const target_ = direction.endsWith("postgres") ? await openPg() : await memoryStore();
        try {
          await scenario(source, target_);
        } finally {
          source.close();
          target_.close();
        }
      },
    );
  }
}

test("invalid or vanished source history refuses before any target write", async () => {
  const source = await memoryStore();
  const target_ = await memoryStore();
  try {
    await source.prompts.importRow(retained("a-valid"));
    await source.prompts.importRow(retained());
    await source.config.setAdminPasswordHash("must-not-arrive");
    const row = retained();
    for (const detail of [
      null,
      { ...row, activeVersion: 2 },
      { ...row, versions: [] },
      { ...row, versions: [...row.versions, ...row.versions] },
      { ...row, versions: row.versions.map((v) => ({ ...v, promptId: "wrong" })) },
      { ...row, versions: row.versions.map((v) => ({ ...v, version: 1 })) },
      { ...row, versions: row.versions.map((v) => ({ ...v, version: -1 })) },
    ]) {
      const unreadable = {
        ...source,
        prompts: {
          ...source.prompts,
          get: async (id: string) => (id === "team" ? detail : source.prompts.get(id)),
        },
      };
      await expect(copyStore(unreadable, target_)).rejects.toThrow("source prompt history");
      expect(await target_.config.getAdminPasswordHash()).toBeNull();
      expect(await target_.prompts.list()).toEqual([]);
    }
  } finally {
    source.close();
    target_.close();
  }
});

test("deterministic key import refusals precede library writes", async () => {
  const source = await memoryStore();
  const target_ = await memoryStore();
  try {
    await source.prompts.importRow(retained());
    const { key } = await seedApiKey(source);
    for (const rows of [
      [{ ...key, limits: null }],
      [key, { ...key, id: "duplicate-hash" }],
      [key, { ...key, hash: "duplicate-id" }],
    ]) {
      await expect(
        copyStore({ ...source, keys: { ...source.keys, list: async () => rows } }, target_),
      ).rejects.toThrow();
      expect(await target_.prompts.list()).toEqual([]);
      expect(await target_.keys.list()).toEqual([]);
      expect(await target_.config.getAdminPasswordHash()).toBeNull();
    }
  } finally {
    source.close();
    target_.close();
  }
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
