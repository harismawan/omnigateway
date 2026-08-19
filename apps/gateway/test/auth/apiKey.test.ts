import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { ApiKey, Store } from "@omni/store";
import { captureLogger, memoryStore, seedApiKey } from "@omni/testkit";
import { authenticateApiKey } from "../../src/auth/apiKey.ts";

async function seed(): Promise<{ store: Store; raw: string }> {
  const store = await memoryStore();
  const { raw } = await seedApiKey(store, { label: "test" });
  return { store, raw };
}

/**
 * The store a row with an unreadable `limits` column produces.
 *
 * Built by wrapping rather than by writing the bad JSON, because `keys.create`
 * validates on the way in and refuses to store a shape no reader can parse —
 * which is the point of that check. `packages/store` owns the parse itself; this
 * owns what auth does once it sees the result.
 */
function withUnreadableLimits(store: Store): Store {
  const blank = (key: ApiKey | null): ApiKey | null =>
    key === null ? null : { ...key, limits: null };
  return {
    ...store,
    keys: {
      ...store.keys,
      list: async () => (await store.keys.list()).map((k) => ({ ...k, limits: null })),
      findByHash: async (hash) => blank(await store.keys.findByHash(hash)),
    },
  };
}

test("accepts a bearer token", async () => {
  const { store, raw } = await seed();
  const key = await authenticateApiKey(store, `Bearer ${raw}`);
  expect(key.label).toBe("test");
});

test("accepts a bare token with no bearer prefix", async () => {
  const { store, raw } = await seed();
  expect((await authenticateApiKey(store, raw)).label).toBe("test");
});

test("rejects a missing header", async () => {
  const { store } = await seed();
  expect(authenticateApiKey(store, undefined)).rejects.toThrow(GatewayError);
});

test("rejects an unknown key", async () => {
  const { store } = await seed();
  expect(authenticateApiKey(store, "Bearer sk-omni-nope")).rejects.toThrow(GatewayError);
});

test("rejects a revoked key", async () => {
  const { store, raw } = await seed();
  const key = await authenticateApiKey(store, raw);
  await store.keys.revoke(key.id);
  expect(authenticateApiKey(store, raw)).rejects.toThrow(GatewayError);
});

test("error messages never contain the presented key", async () => {
  const { store } = await seed();
  try {
    await authenticateApiKey(store, "Bearer sk-omni-secret-value");
    throw new Error("expected throw");
  } catch (e) {
    expect((e as GatewayError).message).not.toContain("secret-value");
  }
});

/**
 * The refusal the nullable `limits` exists to produce.
 *
 * Serving the request instead would ignore a ceiling the operator explicitly
 * set, and `{}` is not available as a fallback for the same reason. `INTERNAL`
 * rather than `AUTH`: the credential is fine, so telling the client its key is
 * bad would send an operator hunting a key that works.
 */
test("a key whose stored limits cannot be read is refused, not served unlimited", async () => {
  const { store, raw } = await seed();
  const healthy = await authenticateApiKey(store, raw);
  const logger = captureLogger();

  const error = await authenticateApiKey(withUnreadableLimits(store), raw, logger).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GatewayError);
  expect((error as GatewayError).code).toBe("INTERNAL");

  // The operator's side: the row is named, at error, on a field `LogFields`
  // already carries. Nothing is added to that allowlist to say this.
  const reported = logger.records.filter((r) => r.level === "error");
  expect(reported).toHaveLength(1);
  expect(reported[0]?.fields.apiKeyId).toBe(healthy.id);
});

test("the refusal tells the client nothing about the key or the gateway's insides", async () => {
  const { store, raw } = await seed();
  const authenticated = await authenticateApiKey(store, raw);

  const error = (await authenticateApiKey(withUnreadableLimits(store), raw).then(
    () => null,
    (e: unknown) => e,
  )) as GatewayError;

  expect(error.message).not.toContain(authenticated.id);
  expect(error.message).not.toContain(authenticated.label);
  expect(error.message).not.toContain(raw);
  // Client-facing text, not a rendered failure: no zod path, no file, no frame.
  expect(error.message).not.toContain("at ");
  expect(error.message).not.toContain(".ts");
});

/**
 * The regression that would make the whole change pointless.
 *
 * `{}` is a parsed, valid, empty matrix — an unlimited key — and it must stay
 * distinguishable from the null that means the column could not be read. Fold
 * the two together in either direction and either every key is refused or no
 * ceiling is ever honoured.
 */
test("a key stored with an empty matrix is unlimited and passes", async () => {
  const store = await memoryStore();
  const { raw } = await seedApiKey(store, { label: "unbounded", limits: {} });
  const logger = captureLogger();

  const key = await authenticateApiKey(store, raw, logger);
  expect(key.limits).toEqual({});
  expect(logger.records.filter((r) => r.level === "error")).toHaveLength(0);
});
