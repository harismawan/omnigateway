import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { DEFAULT_SETTINGS, type VirtualModel } from "../../src/types.ts";
import { forEachStore } from "./harness.ts";

const base = {
  tier: 1,
  weight: 1,
  costPerMTok: { input: 3, output: 15, cacheRead: 0.3 },
  capabilities: { tools: true, images: true, reasoning: true },
};

forEachStore((backend) => {
  test("settings return defaults, persist patches, and merge weights", async () => {
    const s = await backend.fresh();
    expect(await s.config.getSettings()).toEqual(DEFAULT_SETTINGS);
    const next = await s.config.putSettings({
      maxAttempts: 5,
      weights: { ...DEFAULT_SETTINGS.weights, tier: 20 },
    });
    expect(next.maxAttempts).toBe(5);
    expect(next.weights).toEqual({ ...DEFAULT_SETTINGS.weights, tier: 20 });
    expect(await s.config.getSettings()).toEqual(next);
    const again = await s.config.putSettings({ rtkEnabled: true });
    expect(again.maxAttempts).toBe(5);
    expect(again.rtkEnabled).toBe(true);
  });

  /** Old or malformed stored settings must not turn expiry into unbounded retention. */
  test("body retention defaults old rows and rejects malformed stored windows", async () => {
    const s = await backend.fresh();
    expect((await s.config.getSettings()).bodyRetentionDays).toBe(1);
    const write = async (value: string) => {
      if (backend.name === "sqlite") {
        const db = new Database(s.databasePath);
        try {
          db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('settings', ?)", [value]);
        } finally {
          db.close();
        }
      } else {
        const sql = new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string, max: 1 });
        try {
          await sql.unsafe(
            "INSERT INTO settings (key, value) VALUES ('settings', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            [value],
          );
        } finally {
          await sql.close();
        }
      }
    };
    await write(JSON.stringify({ logRetentionDays: 14 }));
    expect((await s.config.getSettings()).bodyRetentionDays).toBe(1);
    expect((await s.config.getSettings()).logRetentionDays).toBe(14);
    for (const bodyRetentionDays of [0, -1, 1.5, 3_651, "7", null]) {
      await write(JSON.stringify({ bodyRetentionDays }));
      expect((await s.config.getSettings()).bodyRetentionDays).toBe(1);
    }
    await s.config.putSettings({ bodyRetentionDays: 7 });
    expect((await s.config.getSettings()).bodyRetentionDays).toBe(7);
    await s.config.putSettings({ logRetentionDays: 2 });
    expect((await s.config.getSettings()).bodyRetentionDays).toBe(7);
  });

  test("virtual models round-trip nested targets, replace on put, and remove", async () => {
    const s = await backend.fresh();
    const model: VirtualModel = {
      id: "fast",
      targets: [
        { ...base, provider: "anthropic", model: "claude-opus-4", credentialId: "c1" },
        { ...base, provider: "custom", model: "x", endpointId: "e1" },
      ],
      strategy: "score",
      isAlias: false,
    };
    await s.config.putModel(model);
    await s.config.putModel({ id: "alias", targets: [], strategy: "roundRobin", isAlias: true });
    await s.config.putModel({ ...model, strategy: "roundRobin" });
    const models = await s.config.listModels();
    expect(models.map((m) => m.id)).toEqual(["alias", "fast"]);
    expect(models[1]).toEqual({ ...model, strategy: "roundRobin" });
    expect(models[0]?.isAlias).toBe(true);
    await s.config.removeModel("fast");
    expect((await s.config.listModels()).map((m) => m.id)).toEqual(["alias"]);
  });

  test("admin password hash starts null, initialises once, and replaces", async () => {
    const s = await backend.fresh();
    expect(await s.config.getAdminPasswordHash()).toBeNull();
    expect(await s.config.setAdminPasswordHashIfAbsent("h1")).toBe(true);
    expect(await s.config.setAdminPasswordHashIfAbsent("h2")).toBe(false);
    expect(await s.config.getAdminPasswordHash()).toBe("h1");
    await s.config.setAdminPasswordHash("h3");
    expect(await s.config.getAdminPasswordHash()).toBe("h3");
  });

  test("viewer password hash is optional and null deletes it", async () => {
    const s = await backend.fresh();
    expect(await s.config.getViewerPasswordHash()).toBeNull();
    await s.config.setViewerPasswordHash("v1");
    expect(await s.config.getViewerPasswordHash()).toBe("v1");
    await s.config.setViewerPasswordHash(null);
    expect(await s.config.getViewerPasswordHash()).toBeNull();
    // Withdrawing the viewer password leaves the admin one alone.
    await s.config.setAdminPasswordHash("a");
    await s.config.setViewerPasswordHash(null);
    expect(await s.config.getAdminPasswordHash()).toBe("a");
  });
});
