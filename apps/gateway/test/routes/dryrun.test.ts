import { expect, test } from "bun:test";
import { createAdminAuth } from "@omni/control";
import { memoryStore, seedCredential, target, virtualModel } from "@omni/testkit";
import { adminRoutes } from "../../src/routes/admin.ts";

const NOW = 1_000_000;

async function harness() {
  const store = await memoryStore();
  const admin = createAdminAuth(store, { now: () => NOW, sessionTtlMs: 60_000 });
  await admin.setPassword("hunter2hunter2");
  const token = await admin.login("hunter2hunter2");
  if (token === null) throw new Error("test admin login failed");
  const cookie = `omni_admin=${token}`;
  const app = adminRoutes({ store, admin, now: () => NOW, sessionTtlMs: 60_000 });

  const post = (path: string, body: unknown, auth = true) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
  return { store, post };
}

test("dry-run ranks healthy candidates and names their score terms", async () => {
  const { store, post } = await harness();
  await seedCredential(store, { id: "a", provider: "anthropic", tier: 1 });
  await seedCredential(store, { id: "b", provider: "anthropic", tier: 1 });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );

  const response = await post("/api/models/fast/dry-run", {});
  const body = (await response.json()) as {
    candidates: Array<{ credentialId: string; reasons: Record<string, number> }>;
    excluded: Array<{ credentialId: string; reason: string }>;
    strategy: string;
    deterministic: boolean;
  };

  expect(response.status).toBe(200);
  expect(body.candidates).toHaveLength(2);
  expect(body.candidates.map((candidate) => candidate.credentialId).sort()).toEqual(["a", "b"]);
  expect(Object.keys(body.candidates[0]?.reasons ?? {}).sort()).toEqual([
    "cost",
    "health",
    "latency",
    "quota",
    "recency",
    "tier",
  ]);
  expect(body.excluded).toEqual([]);
  expect(body.strategy).toBe("score");
  expect(body.deterministic).toBe(true);
});

test("dry-run names disabled and capability exclusions", async () => {
  const { store, post } = await harness();
  await seedCredential(store, { id: "disabled", provider: "anthropic", enabled: false });
  await seedCredential(store, { id: "limited", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [
        target({ provider: "anthropic", model: "claude-opus-4" }),
        target({
          provider: "anthropic",
          model: "claude-haiku-4",
          capabilities: { tools: false, images: true, reasoning: true },
        }),
      ],
    }),
  );

  const body = (await (await post("/api/models/fast/dry-run", { tools: true })).json()) as {
    excluded: Array<{ credentialId: string; model: string; reason: string }>;
  };

  expect(body.excluded).toContainEqual({
    credentialId: "disabled",
    model: "claude-opus-4",
    reason: "disabled",
  });
  expect(body.excluded).toContainEqual({
    credentialId: "limited",
    model: "claude-haiku-4",
    reason: "capability:tools",
  });
});

test("dry-run rejects unknown models and unauthenticated callers", async () => {
  const { post } = await harness();
  expect((await post("/api/models/nope/dry-run", {})).status).toBe(404);
  expect((await post("/api/models/fast/dry-run", {}, false)).status).toBe(401);
});

test("weighted dry-runs are marked non-deterministic for live traffic", async () => {
  const { store, post } = await harness();
  await seedCredential(store, { id: "a", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      strategy: "weighted",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  const body = (await (await post("/api/models/fast/dry-run", {})).json()) as {
    deterministic: boolean;
  };
  expect(body.deterministic).toBe(false);
});
