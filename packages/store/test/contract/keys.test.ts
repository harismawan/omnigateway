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
    expiresAt: null,
    guardrailPolicy: null,
    smartRouting: false,
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
    expect(found).toEqual({
      ...input,
      prompts: { ids: [], inheritGlobal: true },
      createdAt: created.createdAt,
      revokedAt: null,
    });
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

  test("per-model overrides round-trip, and an empty one is refused at write", async () => {
    const s = await backend.fresh();
    const withModels: LimitConfig = {
      requests: { "1m": 600 },
      models: {
        opus: { requests: { "1m": 20 }, spend: { "5h": 5 }, concurrency: 2 },
        "llama3:8b": { tokens: { "1w": 2_000_000 } },
      },
    };
    await s.keys.create(await key("k1", { limits: withModels }));
    expect((await s.keys.get("k1"))?.limits).toEqual(withModels);
    expect((await s.keys.list())[0]?.limits).toEqual(withModels);

    await expect(
      s.keys.setLimits("k1", { models: { opus: {} } } as unknown as LimitConfig),
    ).rejects.toThrow();
    expect((await s.keys.get("k1"))?.limits).toEqual(withModels);
    // Removing every override is writing the matrix without them.
    await s.keys.setLimits("k1", { requests: { "1m": 600 } });
    expect((await s.keys.get("k1"))?.limits).toEqual({ requests: { "1m": 600 } });
  });

  test("expiry round-trips, defaults to never, and is replaced whole", async () => {
    const s = await backend.fresh();
    // A key minted without one never expires, which is what every key that
    // existed before this column reads back as.
    await s.keys.create(await key("k1"));
    expect((await s.keys.get("k1"))?.expiresAt).toBeNull();

    await s.keys.create(await key("k2", { expiresAt: 1_700_000_000_000 }));
    expect((await s.keys.get("k2"))?.expiresAt).toBe(1_700_000_000_000);

    await s.keys.setExpiry("k1", 1_800_000_000_000);
    expect((await s.keys.get("k1"))?.expiresAt).toBe(1_800_000_000_000);
    // Back to never, which is the only way an expiry is removed.
    await s.keys.setExpiry("k1", null);
    expect((await s.keys.get("k1"))?.expiresAt).toBeNull();
    // The other key is untouched: the write names one row.
    expect((await s.keys.get("k2"))?.expiresAt).toBe(1_700_000_000_000);
  });

  test("a usage policy round-trips, defaults to none, and is replaced whole", async () => {
    const s = await backend.fresh();
    // Minted without one, as every key that predates the column was: no
    // guardrail, so the request path never consults a classifier for it.
    await s.keys.create(await key("k1"));
    expect((await s.keys.get("k1"))?.guardrailPolicy).toBeNull();

    await s.keys.create(await key("k2", { guardrailPolicy: "Work only." }));
    expect((await s.keys.get("k2"))?.guardrailPolicy).toBe("Work only.");
    expect((await s.keys.list()).find((k) => k.id === "k2")?.guardrailPolicy).toBe("Work only.");

    await s.keys.setGuardrailPolicy("k1", "Only software engineering.\nRefuse roleplay.");
    expect((await s.keys.get("k1"))?.guardrailPolicy).toBe(
      "Only software engineering.\nRefuse roleplay.",
    );
    // Cleared by writing null, the only spelling of "no guardrail".
    await s.keys.setGuardrailPolicy("k1", null);
    expect((await s.keys.get("k1"))?.guardrailPolicy).toBeNull();
    // The other key is untouched: the write names one row.
    expect((await s.keys.get("k2"))?.guardrailPolicy).toBe("Work only.");
  });

  test("smart routing defaults off, sets, clears", async () => {
    const s = await backend.fresh();
    await s.keys.create(await key("k1"));
    await s.keys.create(await key("k2"));
    expect((await s.keys.get("k1"))?.smartRouting).toBe(false);

    await s.keys.setSmartRouting("k1", true);
    expect((await s.keys.get("k1"))?.smartRouting).toBe(true);
    expect((await s.keys.list()).find((k) => k.id === "k1")?.smartRouting).toBe(true);
    // The write names one row.
    expect((await s.keys.get("k2"))?.smartRouting).toBe(false);

    await s.keys.setSmartRouting("k1", false);
    expect((await s.keys.get("k1"))?.smartRouting).toBe(false);

    // Minted on.
    await s.keys.create(await key("k3", { smartRouting: true }));
    expect((await s.keys.get("k3"))?.smartRouting).toBe(true);
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
      prompts: { ids: [], inheritGlobal: true },
      id: "k_imported",
      label: "carried",
      prefix: "omni_abcdefgh",
      hash: "a".repeat(64),
      modelAllowlist: ["fast"],
      limits: { concurrency: 2 },
      bodyLoggingOptOut: true,
      createdAt: 1_600_000_000_000,
      revokedAt: 1_600_000_100_000,
      expiresAt: 1_600_000_200_000,
      guardrailPolicy: "Office work only.",
      smartRouting: true,
    });
    const row = await s.keys.get("k_imported");
    expect(row?.createdAt).toBe(1_600_000_000_000);
    expect(row?.revokedAt).toBe(1_600_000_100_000);
    // A restore that dropped this would hand back a key that outlives the
    // expiry its operator set, which is the one direction that fails open.
    expect(row?.expiresAt).toBe(1_600_000_200_000);
    // Carried like the expiry: a restore that dropped it would hand back a key
    // freed of the purpose its operator restricted it to.
    expect(row?.guardrailPolicy).toBe("Office work only.");
    // And the routing flag: dropped, a restored key's confidential requests
    // would go to the external model.
    expect(row?.smartRouting).toBe(true);
    expect(row?.limits).toEqual({ concurrency: 2 });
    expect(row?.bodyLoggingOptOut).toBe(true);
    await expect(
      s.keys.importRow({
        prompts: { ids: [], inheritGlobal: true },
        id: "k_broken",
        label: "b",
        prefix: "p",
        hash: "b".repeat(64),
        modelAllowlist: null,
        limits: null,
        bodyLoggingOptOut: false,
        createdAt: 1,
        revokedAt: null,
        expiresAt: null,
        guardrailPolicy: null,
        smartRouting: false,
      }),
    ).rejects.toThrow("unreadable limits");
  });
});
