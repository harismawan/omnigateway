import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  DEFAULT_SETTINGS,
  DEFAULT_SMART_ROUTER_POLICY,
  SMART_ROUTER_POLICY_MAX_CHARS,
  type VirtualModel,
} from "../../src/types.ts";
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

  /**
   * The marker the export worker reads to learn that retention was shortened,
   * however briefly. Monotonic: it never goes backwards, whoever writes.
   */
  test("lowering log retention sets logRetentionLoweredAt; nothing else moves it back", async () => {
    const s = await backend.fresh();
    expect((await s.config.getSettings()).logRetentionLoweredAt).toBe(0);

    // Raising, and unrelated writes, leave it alone.
    await s.config.putSettings({ logRetentionDays: 60 });
    await s.config.putSettings({ maxAttempts: 4 });
    expect((await s.config.getSettings()).logRetentionLoweredAt).toBe(0);

    const before = Date.now();
    const lowered = await s.config.putSettings({ logRetentionDays: 7 });
    expect(lowered.logRetentionLoweredAt).toBeGreaterThanOrEqual(before);
    expect((await s.config.getSettings()).logRetentionLoweredAt).toBe(
      lowered.logRetentionLoweredAt,
    );

    // A second lowering inside the same millisecond still moves it forward.
    const again = await s.config.putSettings({ logRetentionDays: 6 });
    expect(again.logRetentionLoweredAt).toBeGreaterThan(lowered.logRetentionLoweredAt);
    const marker = again.logRetentionLoweredAt;

    // Raising, an equal value, and an unrelated write keep it.
    await s.config.putSettings({ logRetentionDays: 30 });
    await s.config.putSettings({ logRetentionDays: 30, rtkEnabled: true });
    expect((await s.config.getSettings()).logRetentionLoweredAt).toBe(marker);

    // A client resubmitting a stale settings object cannot erase it.
    await s.config.putSettings({ ...DEFAULT_SETTINGS, logRetentionLoweredAt: 0 });
    expect((await s.config.getSettings()).logRetentionLoweredAt).toBe(marker);
    // Nor a malformed one.
    await s.config.putSettings({ logRetentionLoweredAt: "soon" } as unknown as {
      logRetentionLoweredAt: number;
    });
    expect((await s.config.getSettings()).logRetentionLoweredAt).toBe(marker);
    // A larger incoming value is kept: the marker is max(stored, incoming).
    await s.config.putSettings({ logRetentionLoweredAt: marker + 5 });
    expect((await s.config.getSettings()).logRetentionLoweredAt).toBe(marker + 5);
  });

  test("a stale settings write racing a lowering never loses the marker", async () => {
    const a = await backend.fresh();
    const b = await backend.sibling();
    for (let round = 0; round < 15; round++) {
      await a.config.putSettings({ logRetentionDays: 30 });
      const stale = await b.config.getSettings();
      const before = stale.logRetentionLoweredAt;
      // One writer lowers retention while another saves the settings object it
      // read before that — the console's whole-object save.
      await Promise.all([
        a.config.putSettings({ logRetentionDays: 7 }),
        b.config.putSettings({ ...stale, maxAttempts: 2 + (round % 3) }),
      ]);
      expect((await a.config.getSettings()).logRetentionLoweredAt).toBeGreaterThan(before);
    }
  });

  test("guardrail settings default unconfigured and read malformed values safely", async () => {
    const s = await backend.fresh();
    expect((await s.config.getSettings()).guardrailModel).toBeNull();
    expect((await s.config.getSettings()).guardrailTimeoutMs).toBe(10_000);

    await s.config.putSettings({
      guardrailModel: "anthropic/claude-haiku-4",
      guardrailTimeoutMs: 5,
    });
    expect((await s.config.getSettings()).guardrailModel).toBe("anthropic/claude-haiku-4");
    expect((await s.config.getSettings()).guardrailTimeoutMs).toBe(5);

    // A model that is not a non-empty string reads as unconfigured — which, for
    // a key carrying a policy, refuses rather than serving the request unjudged.
    for (const malformed of ["", "   ", 7, true, ["x"]]) {
      await s.config.putSettings({ guardrailModel: malformed } as unknown as {
        guardrailModel: string;
      });
      expect((await s.config.getSettings()).guardrailModel).toBeNull();
    }
    // A timeout outside 1..60_000 or not an integer reads as the default.
    for (const malformed of [0, -1, 1.5, 60_001, "5000", null]) {
      await s.config.putSettings({ guardrailTimeoutMs: malformed } as unknown as {
        guardrailTimeoutMs: number;
      });
      expect((await s.config.getSettings()).guardrailTimeoutMs).toBe(10_000);
    }
    await s.config.putSettings({ guardrailTimeoutMs: 60_000 });
    expect((await s.config.getSettings()).guardrailTimeoutMs).toBe(60_000);

    // The history window defaults to three and reads anything outside 1..10,
    // or not an integer, as the default.
    expect((await s.config.getSettings()).guardrailHistoryTurns).toBe(3);
    for (const turns of [1, 10, 7]) {
      await s.config.putSettings({ guardrailHistoryTurns: turns });
      expect((await s.config.getSettings()).guardrailHistoryTurns).toBe(turns);
    }
    for (const malformed of [0, -1, 11, 2.5, "5", null, true]) {
      await s.config.putSettings({ guardrailHistoryTurns: malformed } as unknown as {
        guardrailHistoryTurns: number;
      });
      expect((await s.config.getSettings()).guardrailHistoryTurns).toBe(3);
    }
  });

  test("smart router settings default off and read malformed values safely", async () => {
    const s = await backend.fresh();
    const fresh = await s.config.getSettings();
    expect(fresh.smartRouterEnabled).toBe(false);
    expect(fresh.smartRouterClassifierModel).toBeNull();
    expect(fresh.smartRouterLocalModel).toBeNull();
    expect(fresh.smartRouterPolicy).toBe(DEFAULT_SMART_ROUTER_POLICY);
    expect(fresh.smartRouterTimeoutMs).toBe(10_000);

    await s.config.putSettings({
      smartRouterEnabled: true,
      smartRouterClassifierModel: "local-judge",
      smartRouterLocalModel: "local-chat",
      smartRouterPolicy: "Anything about Project Falcon.",
      smartRouterTimeoutMs: 5,
    });
    const saved = await s.config.getSettings();
    expect(saved.smartRouterEnabled).toBe(true);
    expect(saved.smartRouterClassifierModel).toBe("local-judge");
    expect(saved.smartRouterLocalModel).toBe("local-chat");
    expect(saved.smartRouterPolicy).toBe("Anything about Project Falcon.");
    expect(saved.smartRouterTimeoutMs).toBe(5);

    // Whatever a stored row holds reads back as the safe value: off, unset, the
    // default policy, the default timeout.
    await s.config.putSettings({
      smartRouterEnabled: "yes",
      smartRouterClassifierModel: "",
      smartRouterLocalModel: "   ",
      smartRouterPolicy: "  ",
      smartRouterTimeoutMs: 0,
    } as unknown as { smartRouterEnabled: boolean });
    const malformed = await s.config.getSettings();
    expect(malformed.smartRouterEnabled).toBe(false);
    expect(malformed.smartRouterClassifierModel).toBeNull();
    expect(malformed.smartRouterLocalModel).toBeNull();
    expect(malformed.smartRouterPolicy).toBe(DEFAULT_SMART_ROUTER_POLICY);
    expect(malformed.smartRouterTimeoutMs).toBe(10_000);

    for (const bad of [7, true, ["x"], null]) {
      await s.config.putSettings({
        smartRouterClassifierModel: bad,
        smartRouterLocalModel: bad,
        smartRouterPolicy: bad,
      } as unknown as { smartRouterPolicy: string });
      const read = await s.config.getSettings();
      expect(read.smartRouterClassifierModel).toBeNull();
      expect(read.smartRouterLocalModel).toBeNull();
      expect(read.smartRouterPolicy).toBe(DEFAULT_SMART_ROUTER_POLICY);
    }
    for (const bad of [-1, 1.5, 60_001, "5000", null]) {
      await s.config.putSettings({ smartRouterTimeoutMs: bad } as unknown as {
        smartRouterTimeoutMs: number;
      });
      expect((await s.config.getSettings()).smartRouterTimeoutMs).toBe(10_000);
    }
    await s.config.putSettings({ smartRouterTimeoutMs: 60_000 });
    expect((await s.config.getSettings()).smartRouterTimeoutMs).toBe(60_000);

    // The policy ceiling is a count of characters, and one over reads as default.
    await s.config.putSettings({ smartRouterPolicy: "x".repeat(SMART_ROUTER_POLICY_MAX_CHARS) });
    expect((await s.config.getSettings()).smartRouterPolicy).toHaveLength(
      SMART_ROUTER_POLICY_MAX_CHARS,
    );
    await s.config.putSettings({
      smartRouterPolicy: "x".repeat(SMART_ROUTER_POLICY_MAX_CHARS + 1),
    });
    expect((await s.config.getSettings()).smartRouterPolicy).toBe(DEFAULT_SMART_ROUTER_POLICY);
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
