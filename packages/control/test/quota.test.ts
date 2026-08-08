import { beforeEach, expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { nodeHttpClient } from "@omni/providers";
import type { CredentialSecrets, Store } from "@omni/store";
import { memoryStore, seedCredential } from "@omni/testkit";
import type { OAuthProvider, UsageReport } from "../src/oauth/types.ts";
import { poll, probe, RATE_LIMIT_COOLDOWN_MS, resetQuotaCooldowns } from "../src/quota.ts";

const NOW = 1_000_000;

beforeEach(() => {
  // Cooldowns are process-local state shared across tests in this file.
  resetQuotaCooldowns();
});

type UsageImpl = (secrets: CredentialSecrets) => Promise<UsageReport | null>;

/** A provider set where only `anthropic` can report usage. */
function providers(usage?: UsageImpl): Readonly<Record<string, OAuthProvider>> {
  const base = {
    id: "anthropic",
    kind: "pkce",
    supportsManualPaste: true,
    start: () => {
      throw new Error("unused");
    },
    exchange: async () => {
      throw new Error("unused");
    },
    refresh: async () => {
      throw new Error("unused");
    },
  };
  const withUsage = { ...base, ...(usage === undefined ? {} : { usage }) };
  return {
    anthropic: withUsage as unknown as OAuthProvider,
    openai: base as unknown as OAuthProvider,
    kimi: base as unknown as OAuthProvider,
  };
}

function deps(store: Store, usage?: UsageImpl) {
  return {
    store,
    providers: providers(usage),
    http: nodeHttpClient(),
    refresh: async (): Promise<CredentialSecrets> => {
      throw new Error("refresh not expected");
    },
    now: () => NOW,
  };
}

const report: UsageReport = {
  windows: [
    { windowType: "fiveHour", used: 62, limit: 100, resetsAt: NOW + 3_600_000 },
    { windowType: "weekly", used: 18, limit: 100, resetsAt: NOW + 86_400_000 },
  ],
};

test("a probe writes one snapshot row per reported window", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  const written = await poll(deps(store, async () => report));
  expect(written).toBe(1);

  const rows = (await store.credentials.listQuota()).sort((a, b) =>
    a.windowType.localeCompare(b.windowType),
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    credentialId: "c1",
    windowType: "fiveHour",
    used: 62,
    limit: 100,
    resetsAt: NOW + 3_600_000,
    observedAt: NOW,
  });
});

test("providers without a usage probe are skipped rather than guessed at", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "openai" });

  let calls = 0;
  const written = await poll(
    deps(store, async () => {
      calls += 1;
      return report;
    }),
  );

  expect(written).toBe(0);
  expect(calls).toBe(0);
  expect(await store.credentials.listQuota()).toHaveLength(0);
});

test("api-key credentials are never probed", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", authType: "apiKey", refreshToken: null });

  expect(await poll(deps(store, async () => report))).toBe(0);
});

test("disabled credentials are not probed", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", enabled: false });

  expect(await poll(deps(store, async () => report))).toBe(0);
});

test("a failing probe leaves the previous snapshot standing and never disables", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await store.credentials.saveQuota([
    {
      credentialId: "c1",
      windowType: "fiveHour",
      startsAt: NOW - 60_000,
      used: 40,
      limit: 100,
      resetsAt: NOW + 60_000,
      observedAt: NOW - 60_000,
    },
  ]);

  await poll(
    deps(store, async () => {
      throw new Error("usage endpoint returned 500");
    }),
  );

  const rows = await store.credentials.listQuota();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.used).toBe(40);
  expect(rows[0]?.observedAt).toBe(NOW - 60_000);
  expect((await store.credentials.get("c1"))?.enabled).toBe(true);
});

test("a probe that reports nothing writes nothing", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  const view = (await store.credentials.get("c1")) as NonNullable<
    Awaited<ReturnType<Store["credentials"]["get"]>>
  >;
  expect(
    await probe(
      deps(store, async () => null),
      view,
    ),
  ).toBeNull();
  expect(await store.credentials.listQuota()).toHaveLength(0);
});

test("a stale token is refreshed before the probe reads with it", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", expiresAt: NOW - 1 });

  let refreshed = 0;
  const seen: Array<string | null> = [];
  const base = deps(store, async (secrets) => {
    seen.push(secrets.accessToken);
    return report;
  });

  await poll({
    ...base,
    refresh: async () => {
      refreshed += 1;
      return {
        accessToken: "test-token-fresh",
        refreshToken: "test-refresh-c1",
        apiKey: null,
        idToken: null,
      };
    },
  });

  expect(refreshed).toBe(1);
  expect(seen).toEqual(["test-token-fresh"]);
});

test("a rate-limited usage endpoint is left alone until its cooldown expires", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  let calls = 0;
  const throttled = deps(store, async () => {
    calls += 1;
    throw new GatewayError("RATE_LIMIT", "anthropic usage endpoint is rate limited");
  });

  await poll(throttled);
  expect(calls).toBe(1);

  // A second pass inside the cooldown must not ask again: these endpoints are
  // throttled separately from inference, so hammering one is how a short poll
  // interval turns into a stream of failed probes.
  await poll(throttled);
  expect(calls).toBe(1);

  const later = { ...throttled, now: () => NOW + RATE_LIMIT_COOLDOWN_MS + 1 };
  await poll(later);
  expect(calls).toBe(2);
});

test("a rate-limited probe never disables the credential", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  await poll(
    deps(store, async () => {
      throw new GatewayError("RATE_LIMIT", "rate limited");
    }),
  );

  expect((await store.credentials.get("c1"))?.enabled).toBe(true);
});
