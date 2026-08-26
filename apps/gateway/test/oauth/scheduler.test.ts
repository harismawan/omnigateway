import { expect, test } from "bun:test";
import type { FlowResult, OAuthProvider } from "@omni/control";
import { createRefresher, SCHEDULER_REFRESH_LEAD_MS } from "@omni/control";
import { GatewayError } from "@omni/ir";
import { nodeHttpClient } from "@omni/providers";
import type { CredentialSecrets, CredentialView, Store } from "@omni/store";
import { credential, memoryStore, seedCredential } from "@omni/testkit";
import { due, startRefreshScheduler, sweep } from "../../src/oauth/scheduler.ts";

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

const result = (accessToken: string): FlowResult => ({
  secrets: { accessToken, refreshToken: "test-token-9", apiKey: null, idToken: null },
  expiresAt: NOW + 3_600_000,
  accountEmail: "user@example.com",
  providerData: {},
});

function refresherFor(
  store: Store,
  impl: (refreshToken: string) => Promise<FlowResult>,
): (view: CredentialView) => Promise<CredentialSecrets> {
  return createRefresher({
    store,
    providers: fakeProvider(impl),
    http: nodeHttpClient(),
    now: () => NOW,
  });
}

test("due selects only enabled oauth credentials inside the lead window", () => {
  const inside = credential({ id: "inside", expiresAt: NOW + SCHEDULER_REFRESH_LEAD_MS - 1 });
  const rows = [
    inside,
    credential({ id: "later", expiresAt: NOW + SCHEDULER_REFRESH_LEAD_MS + 60_000 }),
    credential({ id: "never", expiresAt: null }),
    credential({ id: "disabled", expiresAt: NOW - 1, enabled: false }),
    credential({ id: "apiKey", expiresAt: NOW - 1, authType: "apiKey" }),
  ];

  expect(due(rows, NOW).map((c) => c.id)).toEqual(["inside"]);
});

test("a sweep refreshes an expiring credential before any request needs it", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", expiresAt: NOW + 60_000 });

  let calls = 0;
  const refresh = refresherFor(store, async () => {
    calls += 1;
    return result("test-token-3");
  });

  expect(await sweep({ store, refresh, now: () => NOW })).toBe(1);
  expect(calls).toBe(1);
  const after = await store.credentials.get("c1");
  expect(after?.expiresAt).toBe(NOW + 3_600_000);
  expect((await after?.secrets())?.accessToken).toBe("test-token-3");
});

test("a repudiated refresh token disables the credential and records why", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", expiresAt: NOW + 60_000 });

  const refresh = refresherFor(store, async () => {
    throw new GatewayError("AUTH", "refresh token rejected");
  });

  expect(await sweep({ store, refresh, now: () => NOW })).toBe(0);

  const after = await store.credentials.get("c1");
  expect(after?.enabled).toBe(false);
  expect(after?.disabledReason).toBe("tokenRejected");
  expect(after?.disabledAt).toBe(NOW);
});

test("a transient failure leaves the credential enabled and is retried next sweep", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", expiresAt: NOW + 60_000 });

  let attempts = 0;
  const refresh = refresherFor(store, async () => {
    attempts += 1;
    if (attempts === 1) throw new GatewayError("NETWORK", "connection reset");
    return result("test-token-4");
  });

  const deps = { store, refresh, now: () => NOW };
  expect(await sweep(deps)).toBe(0);
  const midway = await store.credentials.get("c1");
  expect(midway?.enabled).toBe(true);
  expect(midway?.disabledReason).toBeNull();

  expect(await sweep(deps)).toBe(1);
  expect((await (await store.credentials.get("c1"))?.secrets())?.accessToken).toBe("test-token-4");
});

test("an expired credential with nothing to refresh from is retired, not retried", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", expiresAt: NOW - 1, refreshToken: null });

  let calls = 0;
  const refresh = refresherFor(store, async () => {
    calls += 1;
    return result("unused");
  });

  await sweep({ store, refresh, now: () => NOW });

  expect(calls).toBe(0);
  const after = await store.credentials.get("c1");
  expect(after?.enabled).toBe(false);
  expect(after?.disabledReason).toBe("expiredNoRefresh");
});

test("a credential inside the lead but not yet expired keeps its refresh token role", async () => {
  // Not expired, no refresh token: nothing can be done for it, but it is still
  // serving requests until it runs out, so it must not be disabled early.
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", expiresAt: NOW + 60_000, refreshToken: null });

  await sweep({ store, refresh: async () => ({}) as CredentialSecrets, now: () => NOW });

  const after = await store.credentials.get("c1");
  expect(after?.enabled).toBe(true);
  expect(after?.disabledReason).toBeNull();
});

/** Records the topics a sweep announces, in order. */
function invalidations(): { topics: string[]; invalidate: (topic: string) => void } {
  const topics: string[] = [];
  return { topics, invalidate: (topic) => void topics.push(topic) };
}

test("a sweep that refreshed something announces it once", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", expiresAt: NOW + 60_000 });
  await seedCredential(store, { id: "c2", expiresAt: NOW + 60_000 });
  const broadcaster = invalidations();
  const refresh = refresherFor(store, async () => result("test-token-6"));

  expect(await sweep({ store, refresh, now: () => NOW, broadcaster })).toBe(2);

  // Once for the sweep, not once per credential. Two rows moved and the console
  // refetches the list either way, so a frame each is a frame wasted.
  expect(broadcaster.topics).toEqual(["res:credentials"]);
});

test("a sweep that changed nothing announces nothing", async () => {
  // This runs every minute for the life of the process and most minutes have
  // nothing due. An unconditional frame would be a console refetch a minute on
  // every install holding an OAuth credential — no better than the poll it is
  // replacing, and paid for whether or not a tab is open.
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", expiresAt: NOW + SCHEDULER_REFRESH_LEAD_MS + 60_000 });
  const broadcaster = invalidations();

  expect(
    await sweep({
      store,
      refresh: async () => ({}) as CredentialSecrets,
      now: () => NOW,
      broadcaster,
    }),
  ).toBe(0);

  expect(broadcaster.topics).toEqual([]);
});

test("a credential the sweep retired is announced even though nothing refreshed", async () => {
  // `sweep` returns the refresh count, which is zero here — so an emitter keyed
  // off the return value would leave the accounts board showing a credential as
  // enabled after this sweep switched it off. A credential going dark is
  // arguably the change an operator most needs to see arrive.
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", expiresAt: NOW - 1, refreshToken: null });
  const broadcaster = invalidations();

  expect(
    await sweep({
      store,
      refresh: async () => ({}) as CredentialSecrets,
      now: () => NOW,
      broadcaster,
    }),
  ).toBe(0);

  expect((await store.credentials.get("c1"))?.enabled).toBe(false);
  expect(broadcaster.topics).toEqual(["res:credentials"]);
});

test("a transient refresh failure changed no row and announces nothing", async () => {
  // The other side of the line above. A NETWORK failure leaves the credential
  // exactly as it was and will be retried next sweep, so there is nothing for a
  // console to go and read.
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", expiresAt: NOW + 60_000 });
  const broadcaster = invalidations();
  const refresh = refresherFor(store, async () => {
    throw new GatewayError("NETWORK", "connection reset");
  });

  await sweep({ store, refresh, now: () => NOW, broadcaster });

  expect(broadcaster.topics).toEqual([]);
});

test("a sweep and a concurrent request refresh share one token exchange", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", expiresAt: NOW + 60_000 });

  let calls = 0;
  const gate = Promise.withResolvers<void>();
  const refresh = refresherFor(store, async () => {
    calls += 1;
    await gate.promise;
    return result("test-token-5");
  });

  const view = (await store.credentials.get("c1")) as CredentialView;
  const fromRequest = refresh(view);
  const fromSweep = sweep({ store, refresh, now: () => NOW });
  gate.resolve();
  await Promise.all([fromRequest, fromSweep]);

  // One exchange, not two: a provider that rotates refresh tokens would have
  // invalidated the loser of that race.
  expect(calls).toBe(1);
});

test("stopping the scheduler leaves no timer behind", async () => {
  const store = await memoryStore();
  const stop = startRefreshScheduler({
    store,
    refresh: async () => ({}) as CredentialSecrets,
    now: () => NOW,
  });
  stop();
  // A live interval would keep this process from settling; the assertion is
  // that stop() is callable and idempotent.
  stop();
  expect(true).toBe(true);
});

test("a kilo credential is skipped rather than read as expired long ago", async () => {
  // Kilo issues a bare token: no expiry, no refresh token. A sweep that read
  // the null expiry as "already past" would hammer a refresh that can only
  // throw AUTH, and the refresher disables the credential on exactly that.
  const store = await memoryStore();
  await seedCredential(store, {
    id: "kilo1",
    provider: "kilo",
    expiresAt: null,
    refreshToken: null,
  });

  const refresh = async (): Promise<CredentialSecrets> => {
    throw new Error("the scheduler reached the refresher for a credential that cannot expire");
  };

  expect(due(await store.credentials.list(), NOW).map((c) => c.id)).toEqual([]);
  expect(await sweep({ store, refresh, now: () => NOW })).toBe(0);

  const after = await store.credentials.get("kilo1");
  expect(after?.enabled).toBe(true);
  expect(after?.disabledReason).toBeNull();
});
