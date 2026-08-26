import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayError } from "@omni/ir";
import { createStore, deriveKey } from "@omni/store";
import { memoryStore, requestLog, seedApiKey } from "@omni/testkit";
import { listKeys, setKeyLimits, setKeyModels } from "../src/keys.ts";

/**
 * Limits are editable after creation; `bodyLoggingOptOut` is not.
 *
 * The distinction is the point of this operation existing. An opt-out is a
 * promise to whoever holds the key and must not be revocable behind their back.
 * A limit is the operator's own ceiling on their own installation, and a weekly
 * spend cap that cannot be adjusted without minting a new key and redeploying
 * every client is a cap that gets set to unlimited instead.
 */
test("setting limits on an existing key round-trips through the store", async () => {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, { limits: { requests: { "1m": 60 } } });

  const updated = await setKeyLimits(store, key.id, {
    limits: { requests: { "1m": 120 }, tokens: { "1w": 50_000_000 }, spend: { "1w": 25.5 } },
  });

  expect(updated.limits).toEqual({
    requests: { "1m": 120 },
    tokens: { "1w": 50_000_000 },
    spend: { "1w": 25.5 },
  });
  const [stored] = await store.keys.list();
  expect(stored?.limits).toEqual({
    requests: { "1m": 120 },
    tokens: { "1w": 50_000_000 },
    spend: { "1w": 25.5 },
  });
  store.close();
});

/**
 * A write that cannot be parsed back must be refused at the boundary rather
 * than persisted. An unknown limit key read later as "no limit" fails open on a
 * control the operator explicitly set, so the schema is strict all the way down
 * and this is where that strictness has to bite.
 */
test("an unknown dimension or window is refused rather than stored", async () => {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, { limits: { requests: { "1m": 60 } } });

  for (const bad of [
    { limits: { bandwidth: { "1m": 5 } } },
    { limits: { requests: { "2m": 60 } } },
    // `spend` has no per-minute window: a per-minute dollar ceiling is a rate
    // limit in costume, and the schema refuses to invent one.
    { limits: { spend: { "1m": 5 } } },
    // Zero denies every request, which is a revoked key rather than a ceiling.
    { limits: { requests: { "1m": 0 } } },
    { limits: { requests: { "1m": 60 } }, label: "sneaking a second field past" },
    { limits: null },
    {},
  ]) {
    await expect(setKeyLimits(store, key.id, bad)).rejects.toThrow(GatewayError);
  }

  // Nothing was written on the way past the refusals.
  const [stored] = await store.keys.list();
  expect(stored?.limits).toEqual({ requests: { "1m": 60 } });
  store.close();
});

test("unsetting the last limit leaves the key unlimited rather than broken", async () => {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, {
    limits: { requests: { "1m": 60 }, concurrency: 8 },
  });

  const updated = await setKeyLimits(store, key.id, { limits: {} });

  // `{}` and `null` are different facts: the first is a key with no ceilings,
  // the second is a key the gateway refuses because it cannot read them.
  expect(updated.limits).toEqual({});
  expect(updated.limitUsage).toEqual([]);
  const [stored] = await store.keys.list();
  expect(stored?.limits).toEqual({});
  expect(stored?.limits).not.toBeNull();
  store.close();
});

test("an unknown key id is refused rather than becoming an update that matches nothing", async () => {
  const store = await memoryStore();
  await seedApiKey(store);
  await expect(setKeyLimits(store, "not-a-key", { limits: {} })).rejects.toThrow("no such api key");
  store.close();
});

/**
 * Models are editable after creation for the same reason limits are: an
 * allowlist that cannot be adjusted without minting a new key and redeploying
 * every client is an allowlist that gets set to unrestricted instead. Sent
 * whole, like the matrix — `null` and `[]` are different facts and a partial
 * body would have to invent a third meaning for "absent".
 */
test("setting models on an existing key round-trips through the store", async () => {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, { modelAllowlist: ["fast"] });

  const updated = await setKeyModels(store, key.id, { modelAllowlist: ["fast", "smart"] });

  expect(updated.modelAllowlist).toEqual(["fast", "smart"]);
  const [stored] = await store.keys.list();
  expect(stored?.modelAllowlist).toEqual(["fast", "smart"]);
  store.close();
});

test("an empty allowlist denies every model and null restores unrestricted, as distinct writes", async () => {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, { modelAllowlist: ["fast"] });

  const denied = await setKeyModels(store, key.id, { modelAllowlist: [] });
  expect(denied.modelAllowlist).toEqual([]);
  let [stored] = await store.keys.list();
  // [] must not collapse into null: the first is a key allowed nothing, the
  // second is a key allowed everything.
  expect(stored?.modelAllowlist).toEqual([]);

  const restored = await setKeyModels(store, key.id, { modelAllowlist: null });
  expect(restored.modelAllowlist).toBeNull();
  [stored] = await store.keys.list();
  expect(stored?.modelAllowlist).toBeNull();
  store.close();
});

test("a malformed models body is refused rather than stored", async () => {
  const store = await memoryStore();
  const { key } = await seedApiKey(store);

  for (const bad of [
    {},
    { modelAllowlist: "fast" },
    { modelAllowlist: [""] },
    { modelAllowlist: ["fast"], label: "sneaking a second field past" },
  ]) {
    await expect(setKeyModels(store, key.id, bad)).rejects.toThrow(GatewayError);
  }

  // Nothing was written on the way past the refusals.
  const [stored] = await store.keys.list();
  expect(stored?.modelAllowlist).toBeNull();
  store.close();
});

test("setting models on an unknown key id is refused rather than matching no row", async () => {
  const store = await memoryStore();
  await seedApiKey(store);
  await expect(setKeyModels(store, "not-a-key", { modelAllowlist: null })).rejects.toThrow(
    "no such api key",
  );
  store.close();
});

/**
 * The listing carries what has been spent against each ceiling, because the
 * board's summary has to name the limit nearest exhaustion and cannot compute
 * one from the matrix alone.
 */
test("a listed key reports one reading per configured limit, with committed usage", async () => {
  const store = await memoryStore();
  const now = 2_000_000_000_000;
  const { key } = await seedApiKey(store, {
    limits: { requests: { "1m": 60, "1w": 5_000 }, spend: { "1w": 25 }, concurrency: 8 },
  });

  await store.usage.append(
    requestLog({ id: "r1", apiKeyId: key.id, at: now - 30_000, costUsd: 2.5 }),
  );
  await store.usage.append(
    // Inside the week but outside the minute, so the two windows disagree —
    // which is the only way a reading proves it read its own window.
    requestLog({ id: "r2", apiKeyId: key.id, at: now - 3_600_000, costUsd: 1.25 }),
  );

  const [listed] = await listKeys(store, now);
  expect(listed?.limitUsage).toEqual([
    { dimension: "requests", window: "1m", limit: 60, used: 1 },
    { dimension: "requests", window: "1w", limit: 5_000, used: 2 },
    { dimension: "spend", window: "1w", limit: 25, used: 3.75 },
    // A gauge held in the serving process. Zero would tell an operator running
    // the CLI beside a saturated gateway that nothing is in flight.
    { dimension: "concurrency", window: null, limit: 8, used: null },
  ]);
  store.close();
});

test("a key whose stored limits cannot be read keeps its row and reports no readings", async () => {
  const root = mkdtempSync(join(tmpdir(), "omni-keys-"));
  const path = join(root, "omnigateway.db");
  const store = await createStore({
    path,
    encryptionKey: await deriveKey("test-encryption-key-0123456789"),
  });
  const { key } = await seedApiKey(store, { limits: { requests: { "1m": 60 } } });

  // Hand-edited, because that is the only way the row exists: `create` and
  // `setLimits` both refuse a shape no reader could parse.
  const db = new Database(path);
  db.run(`UPDATE api_keys SET limits = '{"bandwidth":{"1m":5}}' WHERE id = ?`, [key.id]);
  db.close();

  const [listed] = await listKeys(store);
  expect(listed?.limits).toBeNull();
  // Nothing to measure against a ceiling nobody can read — and no reading that
  // would render as a comfortable, empty bar.
  expect(listed?.limitUsage).toEqual([]);
  store.close();
  rmSync(root, { recursive: true, force: true });
});
