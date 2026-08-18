import { expect, test } from "bun:test";
import { deriveKey } from "../src/encryption.ts";
import { generateApiKey, hashApiKey } from "../src/sqlite/keys.ts";
import { createStore } from "../src/sqlite/store.ts";
import type { Settings, Store } from "../src/types.ts";

async function store(): Promise<Store> {
  return createStore({
    path: ":memory:",
    encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
  });
}

test("routing subscribers receive committed local changes", async () => {
  const s = await store();
  const changes: string[] = [];
  const unsubscribe = s.routing.subscribe((change) => changes.push(change.type));

  await s.credentials.create({
    id: "c1",
    provider: "anthropic",
    label: "personal",
    authType: "oauth",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: {},
    disabledReason: null,
    disabledAt: null,
    accessToken: "test-token",
    refreshToken: "test-refresh",
    apiKey: null,
    idToken: null,
  });
  await s.credentials.saveHealth([
    {
      credentialId: "c1",
      model: "claude-opus-4",
      breakerState: "closed",
      consecutiveFailures: 0,
      openedAt: null,
      rateLimitedUntil: null,
      ewmaTtftMs: 100,
      lastUsedAt: 200,
    },
  ]);
  await s.credentials.saveQuota([
    {
      credentialId: "c1",
      windowType: "weekly",
      startsAt: 0,
      used: 10,
      limit: 100,
      resetsAt: 1000,
      observedAt: 50,
      windowMs: null,
    },
  ]);
  await s.config.putSettings({ maxAttempts: 4 });

  expect(changes).toEqual(["credentialsChanged", "healthSaved", "quotaSaved", "settingsChanged"]);
  unsubscribe();
  s.close();
});

test("routing subscriber failures do not fail committed writes", async () => {
  const s = await store();
  s.routing.subscribe(() => {
    throw new Error("listener failed");
  });

  await expect(s.config.putSettings({ maxAttempts: 4 })).resolves.toMatchObject({ maxAttempts: 4 });
  expect((await s.config.getSettings()).maxAttempts).toBe(4);
  s.close();
});

test("routing version changes after another connection commits", async () => {
  const path = `/tmp/omnigateway-routing-version-${crypto.randomUUID()}.db`;
  const key = await deriveKey("test-secret-value-for-unit-tests");
  const first = await createStore({ path, encryptionKey: key });
  const second = await createStore({ path, encryptionKey: key });
  const before = first.routing.version();

  await second.config.putSettings({ maxAttempts: 4 });

  expect(first.routing.version()).not.toBe(before);
  first.close();
  second.close();
  await Bun.file(path).delete();
});

test("admin password initialization only writes when absent", async () => {
  const s = await store();
  expect(await s.config.setAdminPasswordHashIfAbsent("first-hash")).toBe(true);
  expect(await s.config.setAdminPasswordHashIfAbsent("second-hash")).toBe(false);
  expect(await s.config.getAdminPasswordHash()).toBe("first-hash");

  await s.config.setAdminPasswordHash("replacement-hash");
  expect(await s.config.getAdminPasswordHash()).toBe("replacement-hash");
  s.close();
});

test("settings safely normalize malformed persisted RTK values to disabled", async () => {
  const s = await store();
  expect((await s.config.getSettings()).rtkEnabled).toBe(false);
  await s.config.putSettings({ rtkEnabled: true });
  expect((await s.config.getSettings()).rtkEnabled).toBe(true);
  s.close();
});

test("body logging settings default off and only literal true enables them", async () => {
  const s = await store();
  const defaults = await s.config.getSettings();
  expect(defaults.bodyLoggingEnabled).toBe(false);
  expect(defaults.bodyLoggingCaptureStreamChunks).toBe(false);

  // A hand-edited or older row: truthy, but not `true`. Capture must not start
  // on a value nobody typed with that meaning.
  await s.config.putSettings({
    bodyLoggingEnabled: "yes",
    bodyLoggingCaptureStreamChunks: 1,
  } as unknown as Partial<Settings>);
  const coerced = await s.config.getSettings();
  expect(coerced.bodyLoggingEnabled).toBe(false);
  expect(coerced.bodyLoggingCaptureStreamChunks).toBe(false);

  await s.config.putSettings({ bodyLoggingEnabled: true, bodyLoggingCaptureStreamChunks: true });
  const enabled = await s.config.getSettings();
  expect(enabled.bodyLoggingEnabled).toBe(true);
  expect(enabled.bodyLoggingCaptureStreamChunks).toBe(true);
  s.close();
});

test("api key body logging opt-out defaults off and round-trips", async () => {
  const s = await store();
  const plain = await hashApiKey(generateApiKey());
  const quiet = await hashApiKey(generateApiKey());
  await s.keys.create({
    id: "k1",
    label: "shared",
    prefix: "sk-omni-aaaa",
    hash: plain,
    modelAllowlist: null,
    rateLimitPerMin: null,
    bodyLoggingOptOut: false,
  });
  await s.keys.create({
    id: "k2",
    label: "confidential",
    prefix: "sk-omni-bbbb",
    hash: quiet,
    modelAllowlist: null,
    rateLimitPerMin: null,
    bodyLoggingOptOut: true,
  });

  expect((await s.keys.findByHash(plain))?.bodyLoggingOptOut).toBe(false);
  expect((await s.keys.findByHash(quiet))?.bodyLoggingOptOut).toBe(true);
  expect((await s.keys.list()).map((k) => k.bodyLoggingOptOut).sort()).toEqual([false, true]);
  s.close();
});

test("settings return defaults then persist patches", async () => {
  const s = await store();
  const defaults = await s.config.getSettings();
  expect(defaults.maxAttempts).toBe(3);
  expect(defaults.weights.tier).toBe(10);

  const patched = await s.config.putSettings({ maxAttempts: 5 });
  expect(patched.maxAttempts).toBe(5);
  expect(patched.weights.tier).toBe(10);
  expect((await s.config.getSettings()).maxAttempts).toBe(5);
  s.close();
});

test("settings drop the retired recency weight and adopt the load default", async () => {
  const s = await store();
  // A row written before load-aware routing: recency present, load absent.
  await s.config.putSettings({
    weights: { tier: 10, health: 3, quota: 2, cost: 1, latency: 1, recency: 0.5 },
  } as unknown as Partial<Settings>);

  const weights: Record<string, number> = (await s.config.getSettings()).weights;
  expect(weights.load).toBe(2);
  expect(weights).not.toHaveProperty("recency");
  s.close();
});

test("virtual models round-trip with nested targets", async () => {
  const s = await store();
  await s.config.putModel({
    id: "fast",
    strategy: "score",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-4",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 15, output: 75 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
  const models = await s.config.listModels();
  expect(models).toHaveLength(1);
  expect(models[0]?.targets[0]?.model).toBe("claude-opus-4");
  expect(models[0]?.targets[0]?.capabilities.tools).toBe(true);
  s.close();
});

test("putModel replaces an existing model rather than duplicating", async () => {
  const s = await store();
  const model = { id: "fast", strategy: "score" as const, isAlias: false, targets: [] };
  await s.config.putModel(model);
  await s.config.putModel({ ...model, strategy: "priority" });
  const models = await s.config.listModels();
  expect(models).toHaveLength(1);
  expect(models[0]?.strategy).toBe("priority");
  s.close();
});

test("admin password hash round-trips and starts null", async () => {
  const s = await store();
  expect(await s.config.getAdminPasswordHash()).toBeNull();
  await s.config.setAdminPasswordHash("hash-value");
  expect(await s.config.getAdminPasswordHash()).toBe("hash-value");
  s.close();
});

test("api keys are found by hash and never store the raw value", async () => {
  const s = await store();
  const raw = generateApiKey();
  expect(raw.startsWith("sk-omni-")).toBe(true);

  const hash = await hashApiKey(raw);
  await s.keys.create({
    id: "k1",
    label: "laptop",
    prefix: raw.slice(0, 12),
    hash,
    modelAllowlist: ["fast"],
    rateLimitPerMin: 60,
    bodyLoggingOptOut: false,
  });

  const found = await s.keys.findByHash(hash);
  expect(found?.label).toBe("laptop");
  expect(found?.modelAllowlist).toEqual(["fast"]);
  expect(JSON.stringify(found)).not.toContain(raw);
  s.close();
});

test("revoked keys are still listed but marked revoked", async () => {
  const s = await store();
  const hash = await hashApiKey(generateApiKey());
  await s.keys.create({
    id: "k1",
    label: "l",
    prefix: "sk-omni-abcd",
    hash,
    modelAllowlist: null,
    rateLimitPerMin: null,
    bodyLoggingOptOut: false,
  });
  await s.keys.revoke("k1");
  const found = await s.keys.findByHash(hash);
  expect(found?.revokedAt).not.toBeNull();
  expect(await s.keys.list()).toHaveLength(1);
  s.close();
});

test("hashApiKey is deterministic and differs per input", async () => {
  const a = generateApiKey();
  const b = generateApiKey();
  expect(await hashApiKey(a)).toBe(await hashApiKey(a));
  expect(await hashApiKey(a)).not.toBe(await hashApiKey(b));
});

test("usage appends, lists recent, and aggregates by model", async () => {
  const s = await store();
  const log = {
    id: "r1",
    state: "done" as const,
    at: 1000,
    apiKeyId: "k1",
    requestedModel: "fast",
    resolvedProvider: "anthropic" as const,
    resolvedModel: "claude-opus-4",
    credentialId: "c1",
    attempts: 1,
    status: 200,
    errorCode: null,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: 300,
    durationMs: 1200,
    costUsd: 0.005,
    degradations: [],
    rtkApplied: false,
    rtkFilterHits: 0,
    rtkOriginalCodeUnits: 0,
    rtkCompressedCodeUnits: 0,
    rtkEstimatedTokensSaved: 0,
    rtkFilters: [],
  };
  await s.usage.append(log);
  await s.usage.append({ ...log, id: "r2", at: 2000, status: 429, errorCode: "RATE_LIMIT" });

  const recent = await s.usage.recent(10);
  expect(recent).toHaveLength(2);
  expect(recent[0]?.id).toBe("r2");
  expect(recent[0]?.degradations).toEqual([]);

  const byModel = await s.usage.aggregate({ since: 0, groupBy: "model" });
  expect(byModel[0]?.key).toBe("claude-opus-4");
  expect(byModel[0]?.requests).toBe(2);
  expect(byModel[0]?.inputTokens).toBe(200);
  expect(byModel[0]?.errors).toBe(1);
  s.close();
});

test("prune removes logs older than the cutoff", async () => {
  const s = await store();
  const base = {
    state: "done" as const,
    apiKeyId: null,
    requestedModel: "m",
    resolvedProvider: null,
    resolvedModel: null,
    credentialId: null,
    attempts: 1,
    status: 200,
    errorCode: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: null,
    durationMs: 1,
    costUsd: 0,
    degradations: [],
    rtkApplied: false,
    rtkFilterHits: 0,
    rtkOriginalCodeUnits: 0,
    rtkCompressedCodeUnits: 0,
    rtkEstimatedTokensSaved: 0,
    rtkFilters: [],
  };
  await s.usage.append({ ...base, id: "old", at: 100 });
  await s.usage.append({ ...base, id: "new", at: 9000 });
  expect(await s.usage.prune(5000)).toBe(1);
  expect(await s.usage.recent(10)).toHaveLength(1);
  s.close();
});
