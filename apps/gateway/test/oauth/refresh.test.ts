import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { nodeHttpClient } from "@omni/providers";
import type { CredentialView, Store } from "@omni/store";
import { createRefresher } from "../../src/oauth/refresh.ts";
import type { FlowResult, OAuthProvider } from "../../src/oauth/types.ts";
import { memoryStore, seedCredential } from "../helpers/fixtures.ts";

const NOW = 1_000_000;

function fakeProvider(
  impl: (refreshToken: string) => Promise<FlowResult>,
): Readonly<Record<string, OAuthProvider>> {
  const provider = {
    id: "anthropic",
    kind: "pkce",
    supportsManualPaste: true,
    start: () => {
      throw new Error("unused");
    },
    exchange: async () => {
      throw new Error("unused");
    },
    refresh: async (token: string) => impl(token),
  } as unknown as OAuthProvider;
  return { anthropic: provider, openai: provider, kimi: provider };
}

async function seed(): Promise<{ store: Store; view: CredentialView }> {
  const store = await memoryStore();
  await seedCredential(store, {
    id: "c1",
    expiresAt: NOW - 1,
    accessToken: "test-token-1",
    refreshToken: "test-token-2",
  });
  const view = (await store.credentials.get("c1")) as CredentialView;
  return { store, view };
}

const result = (accessToken: string): FlowResult => ({
  secrets: { accessToken, refreshToken: "test-token-9", apiKey: null, idToken: null },
  expiresAt: NOW + 3_600_000,
  accountEmail: "user@example.com",
  providerData: { accountId: "acct_1" },
});

test("refreshes and returns the new secrets", async () => {
  const { store, view } = await seed();
  const refresh = createRefresher({
    store,
    providers: fakeProvider(async () => result("test-token-3")),
    http: nodeHttpClient(),
    now: () => NOW,
  });

  expect((await refresh(view)).accessToken).toBe("test-token-3");
});

test("persists the new tokens and expiry", async () => {
  const { store, view } = await seed();
  const refresh = createRefresher({
    store,
    providers: fakeProvider(async () => result("test-token-3")),
    http: nodeHttpClient(),
    now: () => NOW,
  });
  await refresh(view);

  const reloaded = (await store.credentials.get("c1")) as CredentialView;
  expect(reloaded.expiresAt).toBe(NOW + 3_600_000);
  expect((await reloaded.secrets()).accessToken).toBe("test-token-3");
  expect((await reloaded.secrets()).refreshToken).toBe("test-token-9");
});

test("persists the account email the refresh reported", async () => {
  const { store, view } = await seed();
  const refresh = createRefresher({
    store,
    providers: fakeProvider(async () => result("test-token-3")),
    http: nodeHttpClient(),
    now: () => NOW,
  });
  await refresh(view);

  expect((await store.credentials.get("c1"))?.accountEmail).toBe("user@example.com");
});

test("merges returned provider data without dropping existing keys", async () => {
  const store = await memoryStore();
  await seedCredential(store, {
    id: "c1",
    provider: "openai",
    expiresAt: NOW - 1,
    providerData: { deviceId: "dev-1" },
    accessToken: "test-token-1",
    refreshToken: "test-token-2",
  });
  const view = (await store.credentials.get("c1")) as CredentialView;

  const refresh = createRefresher({
    store,
    providers: fakeProvider(async () => result("test-token-3")),
    http: nodeHttpClient(),
    now: () => NOW,
  });
  await refresh(view);

  const reloaded = (await store.credentials.get("c1")) as CredentialView;
  expect(reloaded.providerData).toEqual({ deviceId: "dev-1", accountId: "acct_1" });
});

test("collapses concurrent refreshes of the same credential into one call", async () => {
  const { store, view } = await seed();
  let calls = 0;
  const refresh = createRefresher({
    store,
    providers: fakeProvider(async () => {
      calls += 1;
      await Bun.sleep(5);
      return result("test-token-3");
    }),
    http: nodeHttpClient(),
    now: () => NOW,
  });

  const results = await Promise.all([refresh(view), refresh(view), refresh(view)]);
  expect(calls).toBe(1);
  expect(results.map((r) => r.accessToken)).toEqual([
    "test-token-3",
    "test-token-3",
    "test-token-3",
  ]);
});

test("does not collapse refreshes of different credentials", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", expiresAt: NOW - 1, refreshToken: "test-token-2" });
  await seedCredential(store, { id: "c2", expiresAt: NOW - 1, refreshToken: "test-token-4" });
  const first = (await store.credentials.get("c1")) as CredentialView;
  const second = (await store.credentials.get("c2")) as CredentialView;

  let calls = 0;
  const refresh = createRefresher({
    store,
    providers: fakeProvider(async () => {
      calls += 1;
      await Bun.sleep(5);
      return result("test-token-3");
    }),
    http: nodeHttpClient(),
    now: () => NOW,
  });

  await Promise.all([refresh(first), refresh(second)]);
  expect(calls).toBe(2);
});

test("allows a later refresh once the in-flight one settles", async () => {
  const { store, view } = await seed();
  let calls = 0;
  const refresh = createRefresher({
    store,
    providers: fakeProvider(async () => {
      calls += 1;
      return result(`test-token-${calls}`);
    }),
    http: nodeHttpClient(),
    now: () => NOW,
  });

  await refresh(view);
  await refresh(view);
  expect(calls).toBe(2);
});

test("throws when the credential has no refresh token", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c2", accessToken: "test-token-1", refreshToken: null });
  const view = (await store.credentials.get("c2")) as CredentialView;

  const refresh = createRefresher({
    store,
    providers: fakeProvider(async () => result("x")),
    http: nodeHttpClient(),
    now: () => NOW,
  });
  await expect(refresh(view)).rejects.toThrow(GatewayError);
});

test("disables the credential when the provider rejects the refresh token", async () => {
  const { store, view } = await seed();
  const refresh = createRefresher({
    store,
    providers: fakeProvider(async () => {
      throw new GatewayError("AUTH", "token endpoint rejected the request: invalid_grant");
    }),
    http: nodeHttpClient(),
    now: () => NOW,
  });

  await expect(refresh(view)).rejects.toThrow(GatewayError);
  expect((await store.credentials.get("c1"))?.enabled).toBe(false);
});

test("a network failure does not disable the credential", async () => {
  const { store, view } = await seed();
  const refresh = createRefresher({
    store,
    providers: fakeProvider(async () => {
      throw new GatewayError("NETWORK", "connection reset");
    }),
    http: nodeHttpClient(),
    now: () => NOW,
  });

  await expect(refresh(view)).rejects.toThrow(GatewayError);
  expect((await store.credentials.get("c1"))?.enabled).toBe(true);
});

test("a failed refresh is not cached — the next call retries", async () => {
  const { store, view } = await seed();
  let calls = 0;
  const refresh = createRefresher({
    store,
    providers: fakeProvider(async () => {
      calls += 1;
      if (calls === 1) throw new GatewayError("NETWORK", "connection reset");
      return result("test-token-3");
    }),
    http: nodeHttpClient(),
    now: () => NOW,
  });

  await expect(refresh(view)).rejects.toThrow(GatewayError);
  expect((await refresh(view)).accessToken).toBe("test-token-3");
});
