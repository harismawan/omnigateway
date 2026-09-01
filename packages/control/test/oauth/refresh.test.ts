import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { nodeHttpClient } from "@omni/providers";
import type { CredentialView, Store } from "@omni/store";
import { memoryStore, seedCredential } from "@omni/testkit";
import { OAUTH_PROVIDERS, seedBuiltinOAuth } from "../../src/oauth/index.ts";
import { createRefresher } from "../../src/oauth/refresh.ts";
import type { FlowResult, OAuthProvider } from "../../src/oauth/types.ts";

// The registry starts empty: the five vendor flows moved to `@omni/providers`
// and reach it through `registerOAuthProvider`, the door a plugin's flow uses.
// Seeded here rather than relied on from another file's import, because a test
// that passes only when the whole suite runs is one that passes for the wrong
// reason. Below the imports, not among them: ESM hoists every import, so a call
// written between two of them still runs after both — and reads as though it
// does not.
seedBuiltinOAuth();

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

test("a provider 5xx does not disable the credential", async () => {
  const { store, view } = await seed();
  const refresh = createRefresher({
    store,
    providers: fakeProvider(async () => {
      throw new GatewayError("UPSTREAM", "token endpoint rejected the request: http_500");
    }),
    http: nodeHttpClient(),
    now: () => NOW,
  });

  await expect(refresh(view)).rejects.toThrow(GatewayError);
  expect((await store.credentials.get("c1"))?.enabled).toBe(true);
});

test("a rate-limited refresh does not disable the credential", async () => {
  const { store, view } = await seed();
  const refresh = createRefresher({
    store,
    providers: fakeProvider(async () => {
      throw new GatewayError("RATE_LIMIT", "token endpoint rejected the request: http_429");
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

test("a provider with no OAuth refresh is refused cleanly, prototype names included", async () => {
  // Two things at once, because they are the same bug seen from either end.
  //
  // `refresh.ts` reads `providers[credential.provider]` by a *stored* string and
  // relies on `undefined` to raise `BAD_REQUEST`. `credential.provider` is
  // whatever is in the row, and `PROVIDER_ID_PATTERN` accepts `constructor` — so
  // on an ordinary object literal that lookup answers the `Object` constructor,
  // the guard passes, and `provider.refresh(...)` throws a raw `TypeError` that
  // `classify` reads as `INTERNAL`. Same signature as the 500 `resolveModel`
  // shipped: an internal source expression, reaching the caller.
  //
  // Driven against the real `OAUTH_PROVIDERS`, not a fixture, because the thing
  // under test is that table's own prototype. `custom` is the ordinary half of
  // the guard — a real provider id with no authorization behind it — and proves
  // the assertion is not passing merely because everything throws.
  for (const provider of ["constructor", "toString", "hasOwnProperty", "custom"]) {
    const store = await memoryStore();
    await seedCredential(store, {
      id: "c1",
      provider,
      expiresAt: NOW - 1,
      accessToken: "test-token-1",
      refreshToken: "test-token-2",
    });
    const view = (await store.credentials.get("c1")) as CredentialView;
    const refresh = createRefresher({
      store,
      providers: OAUTH_PROVIDERS,
      http: nodeHttpClient(),
      now: () => NOW,
    });

    const failure = await refresh(view).then(
      () => null,
      (error: unknown) => error,
    );
    expect({ provider, is: failure instanceof GatewayError }).toEqual({ provider, is: true });
    expect(failure).toMatchObject({ code: "BAD_REQUEST" });
    expect((failure as Error).message).toBe("provider does not support OAuth refresh");
    store.close();
  }
});

test("a provider that does have a refresh still reaches it", async () => {
  // The positive control for the loop above: `OAUTH_PROVIDERS` must still answer
  // for its own five, or "refused cleanly" would be true of everything.
  expect(Object.keys(OAUTH_PROVIDERS).sort()).toEqual([
    "anthropic",
    "grok",
    "kilo",
    "kimi",
    "openai",
  ]);
});
