import { expect, test } from "bun:test";
import { memoryCoord } from "@omni/coord";
import { GatewayError } from "@omni/ir";
import { nodeHttpClient } from "@omni/providers";
import type { CredentialSecrets, Store } from "@omni/store";
import { memoryStore, seedCredential } from "@omni/testkit";
import type { OAuthProvider, ResetCredits } from "../../src/oauth/types.ts";
import { type PollerDeps, quotaOps } from "../../src/quota/poll.ts";

const NOW = 1_000_000;

type Calls = { redeemed: { creditId: string; requestId: string }[]; probed: number };

function setup(store: Store, listed: ResetCredits | null, calls: Calls): PollerDeps {
  const flow = {
    id: "openai",
    kind: "pkce",
    supportsManualPaste: true,
    usage: async () => {
      calls.probed += 1;
      return {
        windows: [{ windowType: "weekly", used: 0, limit: 100, resetsAt: null, windowMs: null }],
      };
    },
    resetCredits: async () => listed,
    redeemReset: async (
      _s: unknown,
      _d: unknown,
      _p: unknown,
      creditId: string,
      requestId: string,
    ) => {
      calls.redeemed.push({ creditId, requestId });
      return { windowsReset: 1 };
    },
  };
  // `anthropic` has usage but no resets: the provider without the capability.
  const plain = { id: "anthropic", kind: "pkce", supportsManualPaste: true, usage: flow.usage };
  return {
    store,
    coord: memoryCoord({ now: () => NOW }),
    providers: {
      openai: flow as unknown as OAuthProvider,
      anthropic: plain as unknown as OAuthProvider,
    },
    http: nodeHttpClient(),
    refresh: async (): Promise<CredentialSecrets> => {
      throw new Error("refresh not expected");
    },
    now: () => NOW,
  };
}

const credit = (id: string, status: string, expiresAt: number | null) => ({
  id,
  status,
  title: null,
  grantedAt: null,
  expiresAt,
});

test("with no credit named, the available credit expiring soonest is spent", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "openai" });
  const calls: Calls = { redeemed: [], probed: 0 };
  const ops = quotaOps(
    setup(
      store,
      {
        available: 2,
        credits: [
          credit("late", "available", 9_000),
          credit("spent", "redeemed", 1_000),
          credit("soon", "available", 5_000),
        ],
      },
      calls,
    ),
  );

  const result = await ops.redeemReset({ credentialId: "c1" });

  expect(result).toMatchObject({ credentialId: "c1", creditId: "soon", windowsReset: 1 });
  expect(calls.redeemed.map((r) => r.creditId)).toEqual(["soon"]);
  // Minted per attempt, never supplied by the caller.
  expect(calls.redeemed[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
});

test("a redeem re-reads quota so the router sees the reset before the next poll", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "openai" });
  const calls: Calls = { redeemed: [], probed: 0 };
  const ops = quotaOps(
    setup(store, { available: 1, credits: [credit("a", "available", null)] }, calls),
  );

  const result = await ops.redeemReset({ credentialId: "c1" });

  expect(result.quotaRefreshed).toBe(true);
  expect(calls.probed).toBe(1);
  expect((await store.credentials.listQuota()).map((w) => w.used)).toEqual([0]);
});

test("nothing available, or a named credit that is not, refuses without calling the provider", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "openai" });
  const calls: Calls = { redeemed: [], probed: 0 };
  const ops = quotaOps(
    setup(store, { available: 0, credits: [credit("x", "redeemed", null)] }, calls),
  );

  for (const request of [{ credentialId: "c1" }, { credentialId: "c1", creditId: "x" }]) {
    const error = await ops.redeemReset(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe("CONFLICT");
  }
  expect(calls.redeemed).toEqual([]);
});

test("a provider without resets, and an unknown account, are refused as bad requests", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "a1", provider: "anthropic" });
  const ops = quotaOps(setup(store, null, { redeemed: [], probed: 0 }));

  for (const id of ["a1", "nope"]) {
    const error = await ops.resetCredits(id).catch((e: unknown) => e);
    expect((error as GatewayError).code).toBe("BAD_REQUEST");
  }
  expect(ops.hasResets("openai")).toBe(true);
  expect(ops.hasResets("anthropic")).toBe(false);
});

test("a list the provider could not answer is an upstream failure, not an empty list", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "openai" });
  const ops = quotaOps(setup(store, null, { redeemed: [], probed: 0 }));

  const error = await ops.resetCredits("c1").catch((e: unknown) => e);
  expect((error as GatewayError).code).toBe("UPSTREAM");
});

test("two redeems at once pick from one list each, in turn, never the same credit twice", async () => {
  // Without the account lock both list before either spends, and with no
  // credit named both would take the soonest — or, after it is spent, the next.
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "openai" });
  const calls: Calls = { redeemed: [], probed: 0 };
  const credits = [credit("a", "available", 1_000), credit("b", "available", 2_000)];
  const deps = setup(store, null, calls);
  const flow = deps.providers.openai as OAuthProvider;
  flow.resetCredits = async () => ({
    available: credits.filter((c) => c.status === "available").length,
    credits: credits.map((c) => ({ ...c })),
  });
  const spend = flow.redeemReset;
  flow.redeemReset = async (...args) => {
    const done = await spend?.(...args);
    const spent = credits.find((c) => c.id === args[3]);
    if (spent !== undefined) spent.status = "redeemed";
    return done ?? { windowsReset: null };
  };
  const ops = quotaOps(deps);

  const results = await Promise.allSettled([
    ops.redeemReset({ credentialId: "c1", creditId: "a" }),
    ops.redeemReset({ credentialId: "c1", creditId: "a" }),
  ]);

  expect(calls.redeemed.map((r) => r.creditId)).toEqual(["a"]);
  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
});
