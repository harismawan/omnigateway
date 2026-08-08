import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { CredentialView } from "@omni/store";
import { health, memoryStore, quota, seedCredential } from "@omni/testkit";
import {
  createApiKeyCredential,
  credentialHealth,
  credentialStatus,
  getCredential,
  refreshCredential,
} from "../src/credentials.ts";

const NOW = 1_000_000;

test("getCredential returns metadata without secret loaders", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", refreshToken: "test-refresh" });

  const credential = await getCredential(store, "c1");

  expect(credential).toMatchObject({ id: "c1", hasRefreshToken: true });
  expect("secrets" in credential).toBe(false);
  expect("openForRefresh" in credential).toBe(false);
});

test("getCredential rejects an unknown credential", async () => {
  const store = await memoryStore();

  await expect(getCredential(store, "missing")).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "no such credential",
  });
});

test("createApiKeyCredential applies API-key defaults without returning the key", async () => {
  const store = await memoryStore();

  const created = await createApiKeyCredential(store, {
    provider: "anthropic",
    apiKey: "test-provider-key",
  });

  expect(created).toMatchObject({
    provider: "anthropic",
    label: "anthropic api key",
    authType: "apiKey",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    hasRefreshToken: false,
  });
  expect(JSON.stringify(created)).not.toContain("test-provider-key");
  const stored = (await store.credentials.get(created.id)) as CredentialView;
  expect((await stored.openForInference()).apiKey).toBe("test-provider-key");
});

test("createApiKeyCredential trims a custom label", async () => {
  const store = await memoryStore();

  const created = await createApiKeyCredential(store, {
    provider: "kimi",
    apiKey: "test-provider-key",
    label: "  work  ",
  });

  expect(created.label).toBe("work");
});

test("createApiKeyCredential rejects invalid provider and blank keys", async () => {
  const store = await memoryStore();

  await expect(
    createApiKeyCredential(store, { provider: "other", apiKey: "test-provider-key" }),
  ).rejects.toBeInstanceOf(GatewayError);
  await expect(
    createApiKeyCredential(store, { provider: "openai", apiKey: "   " }),
  ).rejects.toBeInstanceOf(GatewayError);
});

test("refreshCredential refreshes OAuth metadata and returns current expiry", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", expiresAt: NOW - 1 });
  const expiresAt = NOW + 3_600_000;

  const updated = await refreshCredential(
    {
      store,
      refresh: async (credential) => {
        await store.credentials.updateSecrets(
          credential.id,
          { accessToken: "test-new-token" },
          expiresAt,
        );
        return {
          accessToken: "test-new-token",
          refreshToken: null,
          apiKey: null,
          idToken: null,
        };
      },
    },
    "c1",
  );

  expect(updated.expiresAt).toBe(expiresAt);
  expect("secrets" in updated).toBe(false);
});

test("refreshCredential rejects missing and API-key credentials", async () => {
  const store = await memoryStore();
  await seedCredential(store, {
    id: "key-1",
    authType: "apiKey",
    accessToken: null,
    refreshToken: null,
    apiKey: "test-provider-key",
  });
  const refresh = async () => {
    throw new Error("must not refresh");
  };

  await expect(refreshCredential({ store, refresh }, "missing")).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(refreshCredential({ store, refresh }, "key-1")).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: 'credential "key-1" is an api key and has nothing to refresh',
  });
});

test("credentialHealth returns stored health and quota", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await store.credentials.saveHealth([health({ credentialId: "c1", model: "model-1" })]);
  await store.credentials.saveQuota([
    quota({ credentialId: "c1", used: 4, limit: 10, observedAt: NOW }),
  ]);

  const result = await credentialHealth(store);

  expect(result.health).toHaveLength(1);
  expect(result.quota).toHaveLength(1);
});

test("credentialStatus attaches quota and reports admin configuration", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", label: "work" });
  await store.credentials.saveQuota([
    quota({ credentialId: "c1", used: 4, limit: 10, observedAt: NOW }),
  ]);

  const before = await credentialStatus(store, { now: () => NOW });
  expect(before).toEqual({
    adminConfigured: false,
    credentials: [
      {
        id: "c1",
        provider: "anthropic",
        label: "work",
        enabled: true,
        quota: [
          {
            credentialId: "c1",
            windowType: "fiveHour",
            startsAt: 0,
            used: 4,
            limit: 10,
            resetsAt: null,
            observedAt: NOW,
          },
        ],
      },
    ],
  });
});
