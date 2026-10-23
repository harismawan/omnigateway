import { expect, test } from "bun:test";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import { buildSnapshot } from "@omni/router";
import { memoryStore, seedApiKey, target, virtualModel } from "@omni/testkit";
import { smartRouterModelStatus, smartRouterReadiness } from "../src/smartRouter.ts";

const local = (id: string) =>
  virtualModel({
    id,
    targets: [target({ provider: "custom", model: "llama", endpointId: "ollama" })],
  });

test("readiness is healthy while disabled or while no live key carries the flag", async () => {
  const store = await memoryStore();
  await seedApiKey(store, { smartRouting: false });
  const revoked = await seedApiKey(store, { smartRouting: true });
  await store.keys.revoke(revoked.key.id);
  // Enabled, but a revoked key sends nothing.
  await store.config.putSettings({ smartRouterEnabled: true });
  expect(await smartRouterReadiness(store, PROVIDER_DESCRIPTORS)).toEqual({
    enabled: true,
    keysWithFlag: 0,
    classifierModel: null,
    localModel: null,
    problem: null,
  });

  // A live flagged key, but the feature is off.
  await seedApiKey(store, { smartRouting: true });
  await store.config.putSettings({ smartRouterEnabled: false });
  expect(await smartRouterReadiness(store, PROVIDER_DESCRIPTORS)).toMatchObject({
    enabled: false,
    keysWithFlag: 1,
    problem: null,
  });
  store.close();
});

test("readiness names the first failing of unconfigured, unresolved, notLocal", async () => {
  const store = await memoryStore();
  await seedApiKey(store, { smartRouting: true });
  await store.config.putSettings({ smartRouterEnabled: true });
  expect((await smartRouterReadiness(store, PROVIDER_DESCRIPTORS)).problem).toBe("unconfigured");

  await store.config.putSettings({ smartRouterClassifierModel: "judge" });
  expect((await smartRouterReadiness(store, PROVIDER_DESCRIPTORS)).problem).toBe("unconfigured");

  await store.config.putSettings({ smartRouterLocalModel: "private" });
  expect((await smartRouterReadiness(store, PROVIDER_DESCRIPTORS)).problem).toBe("unresolved");

  await store.config.putModel(virtualModel({ id: "judge", targets: [target()] }));
  expect((await smartRouterReadiness(store, PROVIDER_DESCRIPTORS)).problem).toBe("unresolved");

  await store.config.putModel(virtualModel({ id: "private", targets: [target()] }));
  expect((await smartRouterReadiness(store, PROVIDER_DESCRIPTORS)).problem).toBe("notLocal");

  await store.config.putModel(local("private"));
  // The classifier is held to the same rule.
  expect((await smartRouterReadiness(store, PROVIDER_DESCRIPTORS)).problem).toBe("notLocal");

  await store.config.putModel(local("judge"));
  expect(await smartRouterReadiness(store, PROVIDER_DESCRIPTORS)).toEqual({
    enabled: true,
    keysWithFlag: 1,
    classifierModel: "judge",
    localModel: "private",
    problem: null,
  });
  store.close();
});

test("either model failing the local-only rule is notLocal", async () => {
  const store = await memoryStore();
  await seedApiKey(store, { smartRouting: true });
  await store.config.putSettings({
    smartRouterEnabled: true,
    smartRouterClassifierModel: "judge",
    smartRouterLocalModel: "private",
  });
  await store.config.putModel(virtualModel({ id: "judge", targets: [target()] }));
  await store.config.putModel(local("private"));
  expect((await smartRouterReadiness(store, PROVIDER_DESCRIPTORS)).problem).toBe("notLocal");
  store.close();
});

test("model status reports each model on its own, whatever the switch and key flags", async () => {
  const store = await memoryStore();
  const status = async () =>
    smartRouterModelStatus(await buildSnapshot(store, Date.now()), PROVIDER_DESCRIPTORS);
  // Off and no flagged key: still reported, unlike readiness.
  expect(await status()).toEqual({ classifier: "unset", local: "unset" });

  await store.config.putSettings({
    smartRouterClassifierModel: "judge",
    smartRouterLocalModel: "private",
  });
  expect(await status()).toEqual({ classifier: "unresolved", local: "unresolved" });

  await store.config.putModel(virtualModel({ id: "judge", targets: [target()] }));
  await store.config.putModel(local("private"));
  expect(await status()).toEqual({ classifier: "notLocal", local: "ok" });

  await store.config.putModel(local("judge"));
  await store.config.putSettings({ smartRouterLocalModel: null });
  expect(await status()).toEqual({ classifier: "ok", local: "unset" });
  store.close();
});

test("a provider/model shorthand resolves but is never local", async () => {
  const store = await memoryStore();
  await store.config.putSettings({ smartRouterClassifierModel: "anthropic/claude-opus-4" });
  expect(
    smartRouterModelStatus(await buildSnapshot(store, Date.now()), PROVIDER_DESCRIPTORS),
  ).toEqual({ classifier: "notLocal", local: "unset" });
  store.close();
});
