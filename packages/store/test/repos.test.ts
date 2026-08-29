import { expect, test } from "bun:test";
import { createLogger } from "@omni/ir";
import { deriveKey } from "../src/encryption.ts";
import { openDb } from "../src/sqlite/db.ts";
import { createKeyRepo, generateApiKey, hashApiKey } from "../src/sqlite/keys.ts";
import { createStore } from "../src/sqlite/store.ts";
import type { LimitConfig, Settings, Store } from "../src/types.ts";

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

test("auto cache defaults on, and a malformed value reads as off", async () => {
  const s = await store();
  // A row written before this setting existed has no key for it, and must keep
  // caching enabled rather than silently multiplying an operator's input bill.
  expect((await s.config.getSettings()).autoCacheEnabled).toBe(true);

  await s.config.putSettings({ autoCacheEnabled: false });
  expect((await s.config.getSettings()).autoCacheEnabled).toBe(false);

  await s.config.putSettings({ autoCacheEnabled: true });
  expect((await s.config.getSettings()).autoCacheEnabled).toBe(true);

  // Truthy but not `true`, and falsy but not `false`. Both are values nobody
  // typed with that meaning, and this rewrites outbound requests, so both read
  // as off — the same answer the flags around it give.
  for (const malformed of ["yes", 1, 0, null]) {
    await s.config.putSettings({ autoCacheEnabled: malformed } as unknown as {
      autoCacheEnabled: boolean;
    });
    expect((await s.config.getSettings()).autoCacheEnabled).toBe(false);
  }
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
    limits: {},
    bodyLoggingOptOut: false,
  });
  await s.keys.create({
    id: "k2",
    label: "confidential",
    prefix: "sk-omni-bbbb",
    hash: quiet,
    modelAllowlist: null,
    limits: {},
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
    limits: { requests: { "1m": 60 } },
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
    limits: {},
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

test("api key limits round-trip the sparse matrix", async () => {
  const s = await store();
  const hash = await hashApiKey(generateApiKey());
  await s.keys.create({
    id: "k1",
    label: "bounded",
    prefix: "sk-omni-cccc",
    hash,
    modelAllowlist: null,
    limits: {
      requests: { "1m": 60, "5h": 2000 },
      tokens: { "1w": 50_000_000 },
      spend: { "1w": 25.5 },
      concurrency: 8,
    },
    bodyLoggingOptOut: false,
  });

  expect((await s.keys.findByHash(hash))?.limits).toEqual({
    requests: { "1m": 60, "5h": 2000 },
    tokens: { "1w": 50_000_000 },
    spend: { "1w": 25.5 },
    concurrency: 8,
  });
  s.close();
});

/**
 * A limit this build cannot understand marks that key and no other.
 *
 * Two rules meet here. A bad shape must never be read as "no limit", which is
 * failing open on a ceiling the operator explicitly set — `parseRtkFilters` may
 * discard an id it does not know because the worst outcome there is a gap in
 * reported history, and this is not that. But throwing on the way out took the
 * whole listing with it, because `toKey` serves `list` as well as `findByHash`,
 * and the listing is exactly how an operator would find the row to fix. So:
 * refuse at auth, degrade at list.
 */
test("one unreadable limits column costs that key and not the listing", async () => {
  const db = openDb(":memory:");
  const lines: string[] = [];
  const keys = createKeyRepo(
    db,
    createLogger({ level: "debug", write: (line) => lines.push(line) }),
  );
  db.run(
    `INSERT INTO api_keys (id, label, prefix, hash, model_allowlist, limits, created_at)
     VALUES ('bounded', 'bounded', 'sk-omni-cccc', 'h-bounded', NULL, '{"requests":{"1m":60}}', 3),
            ('meddled', 'meddled', 'sk-omni-dddd', 'h-meddled', NULL, '{"bandwidth":{"1m":5}}', 2),
            ('open', 'open', 'sk-omni-eeee', 'h-open', NULL, '{}', 1)`,
  );

  const listed = await keys.list();
  expect(listed.map((k) => k.id)).toEqual(["bounded", "meddled", "open"]);

  // Not merely present: the healthy rows still carry the limits they were
  // stored with, so they are usable rather than collateral damage.
  const byId = new Map(listed.map((k) => [k.id, k]));
  expect(byId.get("bounded")?.limits).toEqual({ requests: { "1m": 60 } });
  expect(byId.get("open")?.limits).toEqual({});
  expect(byId.get("meddled")?.limits).toBeNull();

  // The same on the auth path, which is what turns null into a refusal.
  expect((await keys.findByHash("h-meddled"))?.limits).toBeNull();
  expect((await keys.findByHash("h-bounded"))?.limits).toEqual({ requests: { "1m": 60 } });

  // Degrading quietly would be its own failure: the row is named on stdout.
  expect(lines.some((line) => line.includes("apiKeyId=meddled"))).toBe(true);
  db.close();
});

test("a limits shape the schema refuses is never written", async () => {
  const s = await store();
  await expect(
    s.keys.create({
      id: "k1",
      label: "bad",
      prefix: "sk-omni-eeee",
      hash: await hashApiKey(generateApiKey()),
      modelAllowlist: null,
      // Reached past the control schema, e.g. by a direct store caller.
      limits: { requests: { "2m": 60 } } as unknown as LimitConfig,
      bodyLoggingOptOut: false,
    }),
  ).rejects.toThrow();
  expect(await s.keys.list()).toHaveLength(0);
  s.close();
});

/**
 * The same guard on the edit path, which is the one that matters more.
 *
 * Limits are editable after creation, so `setLimits` is how an operator repairs
 * a key — and a repair that writes a matrix no reader can parse turns a working
 * key into one `authenticateApiKey` answers `INTERNAL` for, by the very command
 * meant to fix it. Only a caller reaching past `@omni/control` gets here, which
 * is exactly the caller the schema is not otherwise standing behind.
 */
test("a limits shape the schema refuses is never written by an edit either", async () => {
  const s = await store();
  const hash = await hashApiKey(generateApiKey());
  await s.keys.create({
    id: "k1",
    label: "bounded",
    prefix: "sk-omni-ffff",
    hash,
    modelAllowlist: null,
    limits: { requests: { "1m": 60 } },
    bodyLoggingOptOut: false,
  });

  await expect(
    s.keys.setLimits("k1", { requests: { "2m": 60 } } as unknown as LimitConfig),
  ).rejects.toThrow();
  // The key is still the key it was: the refused edit left no partial write and
  // nothing the next reader has to interpret.
  expect((await s.keys.findByHash(hash))?.limits).toEqual({ requests: { "1m": 60 } });
  s.close();
});

/**
 * The allowlist is editable after creation, like the matrix: an allowlist that
 * cannot be adjusted without minting a new key and redeploying every client is
 * one that gets set to unrestricted instead. Unlike `limits` there is no
 * write-side parser guard — any JSON array of names round-trips, and a junk
 * entry simply never matches a request, which fails closed per request.
 */
test("setModelAllowlist replaces the column whole and keeps null and [] distinct", async () => {
  const s = await store();
  const hash = await hashApiKey(generateApiKey());
  await s.keys.create({
    id: "k1",
    label: "bounded",
    prefix: "sk-omni-aaaa",
    hash,
    modelAllowlist: ["fast"],
    limits: {},
    bodyLoggingOptOut: false,
  });

  await s.keys.setModelAllowlist("k1", ["fast", "smart"]);
  expect((await s.keys.findByHash(hash))?.modelAllowlist).toEqual(["fast", "smart"]);

  // [] is a key allowed nothing; null is a key allowed everything. Neither
  // may collapse into the other on the way through storage.
  await s.keys.setModelAllowlist("k1", []);
  expect((await s.keys.findByHash(hash))?.modelAllowlist).toEqual([]);

  await s.keys.setModelAllowlist("k1", null);
  expect((await s.keys.findByHash(hash))?.modelAllowlist).toBeNull();
  s.close();
});
test("settings normalize a malformed persisted ponytail mode to off", async () => {
  const s = await store();
  expect((await s.config.getSettings()).ponytailMode).toBe("off");

  await s.config.putSettings({ ponytailMode: "ultra" });
  expect((await s.config.getSettings()).ponytailMode).toBe("ultra");

  // A hand-edited or restored row is the way in that no schema guards. This
  // setting rewrites outbound prompts, so a value nobody typed with that
  // meaning must read as off rather than be guessed at.
  await s.config.putSettings({ ponytailMode: "FULL" as Settings["ponytailMode"] });
  expect((await s.config.getSettings()).ponytailMode).toBe("off");
  s.close();
});
