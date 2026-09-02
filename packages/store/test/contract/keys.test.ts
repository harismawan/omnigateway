import { expect, test } from "bun:test";
import { generateApiKey, hashApiKey } from "../../src/sqlite/keys.ts";
import type { ApiKeyInput, LimitConfig } from "../../src/types.ts";
import { forEachStore } from "./harness.ts";

const limits: LimitConfig = {
  requests: { "1m": 60, "5h": 2000 },
  tokens: { "1w": 50_000_000 },
  spend: { "1w": 25.5 },
  concurrency: 8,
};

async function key(id: string, overrides: Partial<ApiKeyInput> = {}): Promise<ApiKeyInput> {
  return {
    id,
    label: id,
    prefix: "sk-omni-cccc",
    hash: await hashApiKey(generateApiKey()),
    modelAllowlist: null,
    limits: {},
    bodyLoggingOptOut: false,
    ...overrides,
  };
}

forEachStore((backend) => {
  test("keys are found by hash and by id, never listing the raw value", async () => {
    const s = await backend.fresh();
    const raw = generateApiKey();
    const input = await key("k1", {
      hash: await hashApiKey(raw),
      limits,
      modelAllowlist: ["fast"],
      bodyLoggingOptOut: true,
    });
    const created = await s.keys.create(input);
    expect(created.revokedAt).toBeNull();
    expect(typeof created.createdAt).toBe("number");
    const found = await s.keys.findByHash(input.hash);
    expect(found).toEqual({ ...input, createdAt: created.createdAt, revokedAt: null });
    expect(await s.keys.get("k1")).toEqual(found);
    expect(await s.keys.findByHash("nope")).toBeNull();
    expect(await s.keys.get("nope")).toBeNull();
    expect(JSON.stringify(await s.keys.list())).not.toContain(raw);
  });

  test("list is newest first and revoked keys stay listed", async () => {
    const s = await backend.fresh();
    await s.keys.create(await key("old"));
    await new Promise((r) => setTimeout(r, 2));
    await s.keys.create(await key("new"));
    await s.keys.revoke("old");
    const listed = await s.keys.list();
    expect(listed.map((k) => k.id)).toEqual(["new", "old"]);
    expect(listed[1]?.revokedAt).not.toBeNull();
    expect(listed[0]?.revokedAt).toBeNull();
  });

  test("setLimits writes the matrix whole and refuses a shape the schema refuses", async () => {
    const s = await backend.fresh();
    await s.keys.create(await key("k1", { limits }));
    await s.keys.setLimits("k1", { requests: { "1m": 1 } });
    expect((await s.keys.get("k1"))?.limits).toEqual({ requests: { "1m": 1 } });
    await expect(
      s.keys.setLimits("k1", { requests: { "1m": -1 } } as unknown as LimitConfig),
    ).rejects.toThrow();
    await expect(
      s.keys.create(await key("k2", { limits: { nope: 1 } as unknown as LimitConfig })),
    ).rejects.toThrow();
    expect((await s.keys.get("k1"))?.limits).toEqual({ requests: { "1m": 1 } });
    expect(await s.keys.get("k2")).toBeNull();
  });

  test("setModelAllowlist keeps null and [] distinct", async () => {
    const s = await backend.fresh();
    await s.keys.create(await key("k1", { modelAllowlist: ["a", "b"] }));
    await s.keys.setModelAllowlist("k1", []);
    expect((await s.keys.get("k1"))?.modelAllowlist).toEqual([]);
    await s.keys.setModelAllowlist("k1", null);
    expect((await s.keys.get("k1"))?.modelAllowlist).toBeNull();
    await s.keys.setModelAllowlist("k1", ["c"]);
    expect((await s.keys.get("k1"))?.modelAllowlist).toEqual(["c"]);
  });
});

forEachStore((backend) => {
  test("importRow writes a row exactly as read, revocation and dates included", async () => {
    const s = await backend.fresh();
    await s.keys.importRow({
      id: "k_imported",
      label: "carried",
      prefix: "omni_abcdefgh",
      hash: "a".repeat(64),
      modelAllowlist: ["fast"],
      limits: { concurrency: 2 },
      bodyLoggingOptOut: true,
      createdAt: 1_600_000_000_000,
      revokedAt: 1_600_000_100_000,
    });
    const row = await s.keys.get("k_imported");
    expect(row?.createdAt).toBe(1_600_000_000_000);
    expect(row?.revokedAt).toBe(1_600_000_100_000);
    expect(row?.limits).toEqual({ concurrency: 2 });
    expect(row?.bodyLoggingOptOut).toBe(true);
    await expect(
      s.keys.importRow({
        id: "k_broken",
        label: "b",
        prefix: "p",
        hash: "b".repeat(64),
        modelAllowlist: null,
        limits: null,
        bodyLoggingOptOut: false,
        createdAt: 1,
        revokedAt: null,
      }),
    ).rejects.toThrow("unreadable limits");
  });
});
