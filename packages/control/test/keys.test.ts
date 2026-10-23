import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayError } from "@omni/ir";
import { createStore, deriveKey } from "@omni/store";
import { memoryStore, requestLog, seedApiKey } from "@omni/testkit";
import {
  createKey,
  listKeys,
  readOwnKey,
  setKeyExpiry,
  setKeyGuardrail,
  setKeyLimits,
  setKeyModels,
  setKeySmartRouting,
} from "../src/keys.ts";

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
 * The third field editable after minting, and the only one whose edit is
 * reversible in both directions.
 *
 * An instant already behind the clock is accepted rather than refused: it is
 * how "expire this key now" is spelled, and unlike `revoke` it can be undone by
 * moving the instant forward or clearing it. Nothing here may grow a `> now`
 * guard — that would take away the one operation this is for.
 */
test("setting an expiry round-trips, accepts a past instant, and clears back to never", async () => {
  const store = await memoryStore();
  const now = 1_700_000_000_000;
  const { key } = await seedApiKey(store);

  const set = await setKeyExpiry(store, key.id, { expiresAt: now + 86_400_000 }, now);
  expect(set.expiresAt).toBe(now + 86_400_000);
  expect((await store.keys.get(key.id))?.expiresAt).toBe(now + 86_400_000);

  // "Expire it now", which is the whole reason a past instant is not refused.
  const past = await setKeyExpiry(store, key.id, { expiresAt: now - 1 }, now);
  expect(past.expiresAt).toBe(now - 1);

  const cleared = await setKeyExpiry(store, key.id, { expiresAt: null }, now);
  expect(cleared.expiresAt).toBeNull();
  expect((await store.keys.get(key.id))?.expiresAt).toBeNull();
  store.close();
});

test("setting an expiry on an unknown key id is refused rather than matching no row", async () => {
  const store = await memoryStore();
  await seedApiKey(store);
  await expect(setKeyExpiry(store, "not-a-key", { expiresAt: null })).rejects.toThrow(
    "no such api key",
  );
  store.close();
});

/** An absent field is not "never": the two are different instructions. */
test("an expiry edit that names no field is refused", async () => {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, { expiresAt: 1_700_000_000_000 });
  await expect(setKeyExpiry(store, key.id, {})).rejects.toThrow();
  expect((await store.keys.get(key.id))?.expiresAt).toBe(1_700_000_000_000);
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
    { dimension: "requests", window: "1m", limit: 60, used: 1, model: null },
    { dimension: "requests", window: "1w", limit: 5_000, used: 2, model: null },
    { dimension: "spend", window: "1w", limit: 25, used: 3.75, model: null },
    // A gauge held in the serving process. Zero would tell an operator running
    // the CLI beside a saturated gateway that nothing is in flight.
    { dimension: "concurrency", window: null, limit: 8, used: null, model: null },
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

/**
 * An override's readings are its own model's usage, named with the model, after
 * the key-wide ones. The two models' rows sit in both windows, so a reading
 * that summed the whole key, or another model, reads high here.
 */
test("a listed key reports each model override's readings from that model's rows", async () => {
  const store = await memoryStore();
  const now = 2_000_000_000_000;
  const { key } = await seedApiKey(store, {
    limits: {
      requests: { "1m": 60 },
      models: {
        opus: { requests: { "1m": 5 }, spend: { "5h": 4 }, concurrency: 2 },
        "llama3:8b": { tokens: { "1w": 1_000 } },
      },
    },
  });
  const row = (id: string, model: string, at: number, costUsd: number) =>
    store.usage.append(
      requestLog({ id, apiKeyId: key.id, requestedModel: model, at, costUsd, inputTokens: 7 }),
    );
  await row("o1", "opus", now - 30_000, 1);
  await row("o2", "opus", now - 3_600_000, 0.5);
  await row("f1", "fast", now - 20_000, 9);
  await row("l1", "llama3:8b", now - 86_400_000, 0);

  const [listed] = await listKeys(store, now);
  expect(listed?.limitUsage).toEqual([
    { dimension: "requests", window: "1m", limit: 60, used: 2, model: null },
    { dimension: "requests", window: "1m", limit: 5, used: 1, model: "opus" },
    { dimension: "spend", window: "5h", limit: 4, used: 1.5, model: "opus" },
    { dimension: "concurrency", window: null, limit: 2, used: null, model: "opus" },
    { dimension: "tokens", window: "1w", limit: 1_000, used: 8, model: "llama3:8b" },
  ]);
  store.close();
});

test("limits with model overrides are written whole, and an empty override is refused", async () => {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, { limits: { requests: { "1m": 60 } } });
  const limits = { requests: { "1m": 60 }, models: { opus: { concurrency: 1 } } };
  expect((await setKeyLimits(store, key.id, { limits })).limits).toEqual(limits);
  await expect(
    setKeyLimits(store, key.id, { limits: { models: { opus: {} } } }),
  ).rejects.toBeInstanceOf(GatewayError);
  await expect(
    setKeyLimits(store, key.id, { limits: { models: { opus: { models: {} } } } }),
  ).rejects.toBeInstanceOf(GatewayError);
  expect((await store.keys.get(key.id))?.limits).toEqual(limits);
  store.close();
});

test("a usage policy is set, replaced, and cleared through the store", async () => {
  const store = await memoryStore();
  const { key } = await seedApiKey(store);
  expect((await readOwnKey(store, key.id)).guardrailPolicy).toBeNull();

  const set = await setKeyGuardrail(store, key.id, { policy: "  Work only.  " });
  expect(set.guardrailPolicy).toBe("Work only.");
  expect((await store.keys.get(key.id))?.guardrailPolicy).toBe("Work only.");
  // The holder's own summary carries it, as the listing does.
  expect((await readOwnKey(store, key.id)).guardrailPolicy).toBe("Work only.");
  expect((await listKeys(store))[0]?.guardrailPolicy).toBe("Work only.");

  const cleared = await setKeyGuardrail(store, key.id, { policy: null });
  expect(cleared.guardrailPolicy).toBeNull();
  expect((await store.keys.get(key.id))?.guardrailPolicy).toBeNull();

  // Absent is refused rather than read as either value, and nothing is written.
  await setKeyGuardrail(store, key.id, { policy: "Kept." });
  await expect(setKeyGuardrail(store, key.id, {})).rejects.toThrow();
  await expect(setKeyGuardrail(store, key.id, { policy: "  " })).rejects.toThrow();
  expect((await store.keys.get(key.id))?.guardrailPolicy).toBe("Kept.");
  store.close();
});

test("setting a usage policy on an unknown key id is refused rather than matching no row", async () => {
  const store = await memoryStore();
  await seedApiKey(store);
  await expect(setKeyGuardrail(store, "not-a-key", { policy: null })).rejects.toThrow(
    "no such api key",
  );
  store.close();
});

test("a key can be minted with a usage policy", async () => {
  const store = await memoryStore();
  const created = await createKey(store, { label: "staff", guardrailPolicy: "Work only." });
  expect((await store.keys.get(created.id))?.guardrailPolicy).toBe("Work only.");
  const plain = await createKey(store, { label: "plain" });
  expect((await store.keys.get(plain.id))?.guardrailPolicy).toBeNull();
  store.close();
});

test("smart routing is off at mint, mintable on, and toggled through the store", async () => {
  const store = await memoryStore();
  const plain = await createKey(store, { label: "plain" });
  expect((await store.keys.get(plain.id))?.smartRouting).toBe(false);
  const on = await createKey(store, { label: "private", smartRouting: true });
  expect((await store.keys.get(on.id))?.smartRouting).toBe(true);

  const set = await setKeySmartRouting(store, plain.id, { enabled: true });
  expect(set.smartRouting).toBe(true);
  expect((await store.keys.get(plain.id))?.smartRouting).toBe(true);
  expect((await readOwnKey(store, plain.id)).smartRouting).toBe(true);
  expect((await listKeys(store)).find((k) => k.id === plain.id)?.smartRouting).toBe(true);

  const cleared = await setKeySmartRouting(store, plain.id, { enabled: false });
  expect(cleared.smartRouting).toBe(false);
  expect((await store.keys.get(plain.id))?.smartRouting).toBe(false);
  store.close();
});

test("a smart routing edit with an absent or non-boolean flag is refused and writes nothing", async () => {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, { smartRouting: true });
  for (const refused of [{}, { enabled: "yes" }, { enabled: null }, { enabled: true, x: 1 }]) {
    await expect(setKeySmartRouting(store, key.id, refused)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  }
  expect((await store.keys.get(key.id))?.smartRouting).toBe(true);
  store.close();
});

test("setting smart routing on an unknown key id is refused rather than matching no row", async () => {
  const store = await memoryStore();
  await seedApiKey(store);
  await expect(setKeySmartRouting(store, "not-a-key", { enabled: true })).rejects.toThrow(
    "no such api key",
  );
  store.close();
});
