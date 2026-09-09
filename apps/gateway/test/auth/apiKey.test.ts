import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { ApiKey, Store } from "@omni/store";
import { captureLogger, memoryStore, seedApiKey } from "@omni/testkit";
import { authenticateApiKey } from "../../src/auth/apiKey.ts";

/**
 * The instant every case below is judged at.
 *
 * Injected rather than read from the system clock inside the chokepoint, so an
 * expiry boundary can be stated exactly — `expiresAt === now` is the case a
 * test written against `Date.now()` could never hit on purpose.
 */
const NOW = 1_700_000_000_000;

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
  const key = await authenticateApiKey(store, `Bearer ${raw}`, NOW);
  expect(key.label).toBe("test");
});

test("accepts a bare token with no bearer prefix", async () => {
  const { store, raw } = await seed();
  expect((await authenticateApiKey(store, raw, NOW)).label).toBe("test");
});

test("rejects a missing header", async () => {
  const { store } = await seed();
  expect(authenticateApiKey(store, undefined, NOW)).rejects.toThrow(GatewayError);
});

test("rejects an unknown key", async () => {
  const { store } = await seed();
  expect(authenticateApiKey(store, "Bearer sk-omni-nope", NOW)).rejects.toThrow(GatewayError);
});

test("rejects a revoked key", async () => {
  const { store, raw } = await seed();
  const key = await authenticateApiKey(store, raw, NOW);
  await store.keys.revoke(key.id);
  expect(authenticateApiKey(store, raw, NOW)).rejects.toThrow(GatewayError);
});

/**
 * An expired key is refused exactly as a revoked or unknown one is.
 *
 * Same code, same message, deliberately: distinguishing them would let a caller
 * probe which keys exist and which merely lapsed. The assertion is on equality
 * with the revoked case rather than on a literal, so a future edit that gives
 * expiry its own wording fails here rather than shipping the oracle.
 */
test("an expired key is refused indistinguishably from a revoked one", async () => {
  const store = await memoryStore();
  const expired = await seedApiKey(store, { label: "lapsed", expiresAt: NOW - 1 });
  const revoked = await seedApiKey(store, { label: "pulled" });
  await store.keys.revoke(revoked.key.id);
  const unknown = "Bearer sk-omni-nope";

  const refusal = async (header: string): Promise<GatewayError> =>
    (await authenticateApiKey(store, header, NOW).then(
      () => null,
      (e: unknown) => e,
    )) as GatewayError;

  const lapsed = await refusal(expired.raw);
  const pulled = await refusal(revoked.raw);
  const missing = await refusal(unknown);

  expect(lapsed.code).toBe("AUTH");
  expect(lapsed.message).toBe(pulled.message);
  expect(lapsed.message).toBe(missing.message);
});

/**
 * The boundary, at the chokepoint rather than only on the helper.
 *
 * `expiresAt` is when the key stops being accepted, so the instant it names is
 * already outside — one millisecond earlier serves, the named instant does not.
 */
test("a key is served up to its expiry and not at it", async () => {
  const store = await memoryStore();
  const { raw } = await seedApiKey(store, { label: "ticking", expiresAt: NOW });

  expect((await authenticateApiKey(store, raw, NOW - 1)).label).toBe("ticking");
  await expect(authenticateApiKey(store, raw, NOW)).rejects.toThrow(GatewayError);
  await expect(authenticateApiKey(store, raw, NOW + 1)).rejects.toThrow(GatewayError);
});

/**
 * Expiry is answered before the limits parse, so an expired key cannot produce
 * `INTERNAL`.
 *
 * The two refusals mean opposite things — "your credential is over" against
 * "this installation is misconfigured" — and the second sends an operator
 * hunting a key that is simply past its date. Order is the whole fix.
 */
test("an expired key with an unreadable limits column still answers AUTH", async () => {
  const store = await memoryStore();
  const { raw } = await seedApiKey(store, { label: "lapsed", expiresAt: NOW - 1 });
  const logger = captureLogger();

  const error = (await authenticateApiKey(withUnreadableLimits(store), raw, NOW, logger).then(
    () => null,
    (e: unknown) => e,
  )) as GatewayError;

  expect(error.code).toBe("AUTH");
  // Nothing was reported to the operator either: there is no misconfiguration
  // here, only a key past its date.
  expect(logger.records.filter((r) => r.level === "error")).toHaveLength(0);
});

test("error messages never contain the presented key", async () => {
  const { store } = await seed();
  try {
    await authenticateApiKey(store, "Bearer sk-omni-secret-value", NOW);
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
  const healthy = await authenticateApiKey(store, raw, NOW);
  const logger = captureLogger();

  const error = await authenticateApiKey(withUnreadableLimits(store), raw, NOW, logger).then(
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
  const authenticated = await authenticateApiKey(store, raw, NOW);

  const error = (await authenticateApiKey(withUnreadableLimits(store), raw, NOW).then(
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

  const key = await authenticateApiKey(store, raw, NOW, logger);
  expect(key.limits).toEqual({});
  expect(logger.records.filter((r) => r.level === "error")).toHaveLength(0);
});
