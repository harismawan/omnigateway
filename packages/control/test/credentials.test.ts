import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { CredentialView } from "@omni/store";
import { captureLogger, health, memoryStore, quota, seedCredential } from "@omni/testkit";
import {
  createApiKeyCredential,
  credentialHealth,
  credentialStatus,
  getCredential,
  patchCredential,
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

test("createApiKeyCredential logs credential metadata without the API key", async () => {
  const store = await memoryStore();
  const logger = captureLogger();

  const created = await createApiKeyCredential(
    store,
    { provider: "anthropic", apiKey: "PROVIDER_KEY_SENTINEL" },
    logger,
  );

  expect(logger.records).toContainEqual(
    expect.objectContaining({
      level: "info",
      msg: "credential added",
      fields: expect.objectContaining({ credentialId: created.id, provider: "anthropic" }),
    }),
  );
  expect(logger.lines.join("\n")).not.toContain("PROVIDER_KEY_SENTINEL");
});

test("patchCredential logs enabled-state transitions only", async () => {
  const store = await memoryStore();
  const logger = captureLogger();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  const deps = { store, now: () => NOW, logger };

  await patchCredential(deps, "c1", { label: "renamed" });
  await patchCredential(deps, "c1", { enabled: false });
  await patchCredential(deps, "c1", { enabled: false });
  await patchCredential(deps, "c1", { enabled: true });

  expect(logger.records.map(({ msg }) => msg)).toEqual([
    "credential disabled",
    "credential enabled",
  ]);
  expect(logger.records[0]?.fields).toMatchObject({ credentialId: "c1", provider: "anthropic" });
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

test("createApiKeyCredential normalizes custom endpoint metadata", async () => {
  const store = await memoryStore();

  const created = await createApiKeyCredential(store, {
    provider: "custom",
    apiKey: "test-provider-key",
    endpointId: " local-vllm ",
    endpointLabel: " Local vLLM ",
    origin: "http://localhost:8000/",
    protocol: "chat_completions",
  });

  expect(created).toMatchObject({
    provider: "custom",
    providerData: {
      endpointId: "local-vllm",
      endpointLabel: "Local vLLM",
      origin: "http://localhost:8000",
      protocol: "chat_completions",
    },
  });
});

test("createApiKeyCredential rejects forbidden origins and endpoint conflicts", async () => {
  const store = await memoryStore();
  const base = {
    provider: "custom",
    apiKey: "test-provider-key",
    endpointId: "local-vllm",
    endpointLabel: "Local vLLM",
    protocol: "responses",
  };

  for (const origin of [
    "ftp://localhost",
    "https://user:pass@example.com",
    "https://example.com/v1",
    "https://example.com?x=1",
    "https://example.com#x",
  ]) {
    await expect(createApiKeyCredential(store, { ...base, origin })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  }

  await createApiKeyCredential(store, { ...base, origin: "https://example.com" });
  await expect(
    createApiKeyCredential(store, {
      ...base,
      apiKey: "second-test-key",
      origin: "https://other.example.com",
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

test("createApiKeyCredential permits matching metadata for multiple keys", async () => {
  const store = await memoryStore();
  const endpoint = {
    provider: "custom",
    endpointId: "local-vllm",
    endpointLabel: "Local vLLM",
    origin: "https://example.com/",
    protocol: "responses",
  };

  await createApiKeyCredential(store, { ...endpoint, apiKey: "first-test-key" });
  await createApiKeyCredential(store, { ...endpoint, apiKey: "second-test-key" });

  expect(await store.credentials.list()).toHaveLength(2);
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

  const result = await credentialHealth({ store, now: () => NOW });

  expect(result.health).toHaveLength(1);
  expect(result.quota).toHaveLength(1);
});

test("credentialHealth derives a burn estimate per reported window", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await store.credentials.saveQuota([
    quota({
      credentialId: "c1",
      windowType: "fiveHour",
      // Read two hours into a five-hour window: 100 used is 50 an hour.
      used: 100,
      limit: 1_000,
      resetsAt: NOW + 3 * 3_600_000,
      observedAt: NOW,
    }),
  ]);

  const result = await credentialHealth({ store, now: () => NOW });

  expect(result.burn).toEqual([
    {
      credentialId: "c1",
      windowType: "fiveHour",
      windowStartsAt: NOW - 2 * 3_600_000,
      ratePerHour: 50,
      exhaustsAt: NOW + 18 * 3_600_000,
      survives: true,
      stale: false,
    },
  ]);
});

test("credentialHealth reads no request logs at all", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await store.credentials.saveQuota([
    quota({
      credentialId: "c1",
      windowType: "fiveHour",
      used: 100,
      limit: 1_000,
      resetsAt: NOW + 3 * 3_600_000,
      observedAt: NOW,
    }),
  ]);
  // The console refetches this route every ten seconds against the same
  // synchronous connection that serves inference. A week-scale aggregate here
  // is not a slow query, it is head-of-line blocking on the hot path, so the
  // absence of the call is the property under test. Only a throw proves it was
  // never made; asserting on a value would pass either way.
  store.usage.aggregate = () => {
    throw new Error("credentialHealth must not aggregate request logs");
  };

  const result = await credentialHealth({ store, now: () => NOW });

  expect(result.burn).toHaveLength(1);
  expect(result.burn[0]?.ratePerHour).toBe(50);
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
            windowMs: null,
          },
        ],
      },
    ],
  });
});
