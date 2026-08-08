import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { Store } from "@omni/store";
import { memoryStore, seedApiKey } from "@omni/testkit";
import { authenticateApiKey } from "../../src/auth/apiKey.ts";

async function seed(): Promise<{ store: Store; raw: string }> {
  const store = await memoryStore();
  const { raw } = await seedApiKey(store, { label: "test" });
  return { store, raw };
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
