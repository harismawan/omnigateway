import { expect, test } from "bun:test";
import { type Coord, memoryCoord } from "@omni/coord";
import { GatewayError } from "@omni/ir";
import { nodeHttpClient } from "@omni/providers";
import type { CredentialSecrets, Store, UsageSecrets } from "@omni/store";
import { captureLogger, memoryStore, seedCredential } from "@omni/testkit";
import type { OAuthProvider, UsageReport } from "../../src/oauth/types.ts";
import {
  type PollerDeps,
  type QuotaRefreshOutcome,
  quotaOps,
  RATE_LIMIT_COOLDOWN_MS,
} from "../../src/quota/poll.ts";

const NOW = 1_000_000;

type UsageImpl = (secrets: UsageSecrets) => Promise<UsageReport | null>;

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
  };
}

function deps(
  store: Store,
  usage?: UsageImpl,
  now: () => number = () => NOW,
  coord: Coord = memoryCoord({ now }),
): PollerDeps {
  return {
    store,
    coord,
    providers: providers(usage),
    http: nodeHttpClient(),
    refresh: async (): Promise<CredentialSecrets> => {
      throw new Error("refresh not expected");
    },
    now,
  };
}

/**
 * A coordinator whose lock serialises nothing.
 *
 * The in-memory mutex would queue two callers and let the second one answer
 * from what the first wrote — which is the cross-replica guarantee, and it
 * hides whether the in-process map works at all. Removing that lock is what
 * leaves the local map as the only thing between one account and two calls.
 */
function unserialised(now: () => number): Coord {
  return {
    ...memoryCoord({ now }),
    mutex: { withLock: (_key, _ttlMs, _waitMs, fn) => fn() },
  };
}

const report: UsageReport = {
  windows: [
    { windowType: "fiveHour", used: 62, limit: 100, resetsAt: NOW + 3_600_000, windowMs: null },
    { windowType: "weekly", used: 18, limit: 100, resetsAt: NOW + 86_400_000, windowMs: null },
  ],
};

/** The one outcome a single-account refresh produced. */
async function refreshOne(
  ops: ReturnType<typeof quotaOps>,
  credentialId: string,
): Promise<QuotaRefreshOutcome> {
  const result = await ops.refresh({ kind: "one", credentialId });
  expect(result.outcomes).toHaveLength(1);
  const only = result.outcomes[0];
  if (only === undefined) throw new Error("no outcome");
  return only;
}

test("a refreshed account reports the windows it wrote", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  const ops = quotaOps(deps(store, async () => report));
  expect(await refreshOne(ops, "c1")).toEqual({
    kind: "refreshed",
    credentialId: "c1",
    windows: 2,
  });
  expect(await store.credentials.listQuota()).toHaveLength(2);
});

test("a provider that reports nothing is no data, not an empty reading", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  const ops = quotaOps(deps(store, async () => null));
  expect(await refreshOne(ops, "c1")).toEqual({ kind: "noData", credentialId: "c1" });
  expect(await store.credentials.listQuota()).toHaveLength(0);
});

test("an api-key account and a provider without usage are both unsupported", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "key", authType: "apiKey", refreshToken: null });
  await seedCredential(store, { id: "other", provider: "openai" });

  const ops = quotaOps(deps(store, async () => report));
  expect((await refreshOne(ops, "key")).kind).toBe("unsupported");
  expect((await refreshOne(ops, "other")).kind).toBe("unsupported");
});

test("a disabled account is named, not probed", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", enabled: false });

  let calls = 0;
  const ops = quotaOps(
    deps(store, async () => {
      calls += 1;
      return report;
    }),
  );

  expect(await refreshOne(ops, "c1")).toEqual({ kind: "disabled", credentialId: "c1" });
  expect(calls).toBe(0);
});

test("a failing probe is reported by code alone and keeps the account enabled", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  const ops = quotaOps(
    deps(store, async () => {
      throw new GatewayError("UPSTREAM", "anthropic said 500: token sk-ant-secret leaked here");
    }),
  );

  const outcome = await refreshOne(ops, "c1");
  expect(outcome).toEqual({ kind: "failed", credentialId: "c1", code: "UPSTREAM" });
  // The upstream text must not ride out on the outcome.
  expect(JSON.stringify(outcome)).not.toContain("sk-ant-secret");
  expect((await store.credentials.get("c1"))?.enabled).toBe(true);
});

test("a rate-limited probe fails once, then reports cooldown until it expires", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  let calls = 0;
  let clock = NOW;
  const ops = quotaOps(
    deps(
      store,
      async () => {
        calls += 1;
        throw new GatewayError("RATE_LIMIT", "rate limited");
      },
      () => clock,
    ),
  );

  expect(await refreshOne(ops, "c1")).toEqual({
    kind: "failed",
    credentialId: "c1",
    code: "RATE_LIMIT",
  });
  expect(await refreshOne(ops, "c1")).toEqual({ kind: "cooldown", credentialId: "c1" });
  expect(calls).toBe(1);

  clock = NOW + RATE_LIMIT_COOLDOWN_MS + 1;
  expect((await refreshOne(ops, "c1")).kind).toBe("failed");
  expect(calls).toBe(2);
});

test("a failure leaves an ageing snapshot exactly as it was", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await store.credentials.saveQuota([
    {
      credentialId: "c1",
      windowType: "fiveHour",
      startsAt: NOW - 60_000,
      used: 40,
      limit: 100,
      resetsAt: NOW - 1,
      observedAt: NOW - 60_000,
      windowMs: null,
    },
  ]);

  const ops = quotaOps(
    deps(store, async () => {
      throw new Error("usage endpoint returned 500");
    }),
  );
  expect((await refreshOne(ops, "c1")).kind).toBe("failed");

  // Both halves: the reading survives, and it keeps the rolled-over reset that
  // makes the console call it stale rather than call it zero.
  const rows = await store.credentials.listQuota();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ used: 40, observedAt: NOW - 60_000, resetsAt: NOW - 1 });
});

test("no data leaves an ageing snapshot exactly as it was", async () => {
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
      windowMs: null,
    },
  ]);

  const ops = quotaOps(deps(store, async () => null));
  expect((await refreshOne(ops, "c1")).kind).toBe("noData");

  const rows = await store.credentials.listQuota();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ used: 40, observedAt: NOW - 60_000 });
});

test("an unknown or empty account id is refused before any probe runs", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  let calls = 0;
  const ops = quotaOps(
    deps(store, async () => {
      calls += 1;
      return report;
    }),
  );

  await expect(ops.refresh({ kind: "one", credentialId: "nope" })).rejects.toThrow(
    "no such credential",
  );
  await expect(ops.refresh({ kind: "one", credentialId: "  " })).rejects.toThrow(
    "no such credential",
  );
  expect(calls).toBe(0);
});

test("a bulk refresh answers for every stored account, in list order", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await seedCredential(store, { id: "c2", enabled: false });
  await seedCredential(store, { id: "c3", provider: "openai" });
  await seedCredential(store, { id: "c4" });

  const listed = (await store.credentials.list()).map((c) => c.id);
  const ops = quotaOps(deps(store, async () => report));
  const { outcomes } = await ops.refresh({ kind: "all" });

  // Every visible account is explained, and the answer arrives in the order the
  // operator sees rather than the order the workers finished.
  expect(outcomes.map((o) => o.credentialId)).toEqual(listed);
  const byId = new Map(outcomes.map((o) => [o.credentialId, o.kind]));
  expect(byId.get("c1")).toBe("refreshed");
  expect(byId.get("c2")).toBe("disabled");
  expect(byId.get("c3")).toBe("unsupported");
  expect(byId.get("c4")).toBe("refreshed");
});

test("one account's failure does not stop the accounts behind it", async () => {
  const store = await memoryStore();
  for (const id of ["c1", "c2", "c3", "c4", "c5", "c6"]) {
    await seedCredential(store, { id });
  }

  const ops = quotaOps(
    deps(store, async (secrets) => {
      if (secrets.accessToken === "test-token-c2") throw new Error("that one is broken");
      return report;
    }),
  );
  const { outcomes } = await ops.refresh({ kind: "all" });

  expect(outcomes).toHaveLength(6);
  expect(outcomes.filter((o) => o.kind === "refreshed")).toHaveLength(5);
  expect(outcomes.filter((o) => o.kind === "failed")).toHaveLength(1);
});

test("a bulk refresh never probes more than four accounts at once", async () => {
  const store = await memoryStore();
  for (const id of ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]) {
    await seedCredential(store, { id });
  }

  let inFlight = 0;
  let peak = 0;
  const ops = quotaOps(
    deps(store, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return report;
    }),
  );

  await ops.refresh({ kind: "all" });
  expect(peak).toBe(4);
});

test("the sweep counts only the accounts that wrote a snapshot", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await seedCredential(store, { id: "c2", enabled: false });
  await seedCredential(store, { id: "c3", provider: "openai" });
  await seedCredential(store, { id: "c4", authType: "apiKey", refreshToken: null });
  await seedCredential(store, { id: "c5" });

  const ops = quotaOps(deps(store, async () => report));
  expect(await ops.poll()).toBe(2);
});

test("a manual refresh joins the sweep's probe instead of making a second one", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  let calls = 0;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const ops = quotaOps(
    deps(
      store,
      async () => {
        calls += 1;
        await held;
        return report;
      },
      () => NOW,
      unserialised(() => NOW),
    ),
  );

  // The sweep is mid-probe when the operator asks; one instance, so the second
  // caller finds the first one's promise rather than the provider.
  const sweep = ops.poll();
  await Promise.resolve();
  const manual = ops.refresh({ kind: "one", credentialId: "c1" });
  release?.();

  const [written, { outcomes }] = await Promise.all([sweep, manual]);
  expect(calls).toBe(1);
  expect(written).toBe(1);
  // Shared the call, so it did not write it — and says so.
  expect(outcomes[0]).toEqual({ kind: "coalesced", credentialId: "c1", windows: 2 });
});

test("two simultaneous refreshes of one account make one provider call", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  let calls = 0;
  const ops = quotaOps(
    deps(
      store,
      async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return report;
      },
      () => NOW,
      unserialised(() => NOW),
    ),
  );

  const [a, b] = await Promise.all([
    ops.refresh({ kind: "one", credentialId: "c1" }),
    ops.refresh({ kind: "one", credentialId: "c1" }),
  ]);

  expect(calls).toBe(1);
  const kinds = [a.outcomes[0]?.kind, b.outcomes[0]?.kind].sort();
  expect(kinds).toEqual(["coalesced", "refreshed"]);
});

test("a retried account is probed again once the first attempt has finished", async () => {
  // The in-flight entry is dropped when the probe settles, so coalescing is a
  // window and not a memory of the account's answer.
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  let calls = 0;
  const ops = quotaOps(
    deps(store, async () => {
      calls += 1;
      return null;
    }),
  );

  expect((await refreshOne(ops, "c1")).kind).toBe("noData");
  expect((await refreshOne(ops, "c1")).kind).toBe("noData");
  expect(calls).toBe(2);
});

test("a second replica answers from the reading the first one just wrote", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  let calls = 0;
  const coord = memoryCoord({ now: () => NOW });
  const usage: UsageImpl = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return report;
  };

  // Two instances: separate in-flight maps, one coordinator. Only the lock and
  // the reread stand between them.
  const one = quotaOps(deps(store, usage, () => NOW, coord));
  const two = quotaOps(deps(store, usage, () => NOW, coord));

  const [a, b] = await Promise.all([
    one.refresh({ kind: "one", credentialId: "c1" }),
    two.refresh({ kind: "one", credentialId: "c1" }),
  ]);

  expect(calls).toBe(1);
  const kinds = [a.outcomes[0]?.kind, b.outcomes[0]?.kind].sort();
  expect(kinds).toEqual(["coalesced", "refreshed"]);
});

test("a second replica retries an attempt that wrote nothing", async () => {
  // Nothing is persisted for a failed or empty probe, so there is nothing for
  // the waiter to read and it asks again. That is the accepted cost of not
  // keeping a distributed marker for every outcome.
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  let calls = 0;
  const coord = memoryCoord({ now: () => NOW });
  const usage: UsageImpl = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return null;
  };

  const one = quotaOps(deps(store, usage, () => NOW, coord));
  const two = quotaOps(deps(store, usage, () => NOW, coord));

  const [a, b] = await Promise.all([
    one.refresh({ kind: "one", credentialId: "c1" }),
    two.refresh({ kind: "one", credentialId: "c1" }),
  ]);

  expect(calls).toBe(2);
  expect(a.outcomes[0]?.kind).toBe("noData");
  expect(b.outcomes[0]?.kind).toBe("noData");
});

test("an unavailable coordinator costs a duplicate call, never the refresh", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  const logger = captureLogger();

  const broken: Coord = {
    ...memoryCoord({ now: () => NOW }),
    mutex: {
      withLock: async () => {
        throw new Error("coordinator unreachable");
      },
    },
  };

  const ops = quotaOps({
    ...deps(
      store,
      async () => report,
      () => NOW,
      broken,
    ),
    logger,
  });

  expect(await refreshOne(ops, "c1")).toEqual({
    kind: "refreshed",
    credentialId: "c1",
    windows: 2,
  });
  const fallback = logger.records.filter((r) => r.msg === "quota probe lock unavailable");
  expect(fallback).toHaveLength(1);
  expect(fallback[0]?.fields?.coordFallback).toBe(true);
});

test("an unreachable coordinator costs a duplicate call, not the refresh", async () => {
  // The Redis coordinator answers an outage by throwing, and `kv` has no
  // fail-open of its own. Before this, one blip turned a bulk refresh into a
  // single rejected request instead of a page of outcomes.
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await seedCredential(store, { id: "c2" });
  const logger = captureLogger();

  const down: Coord = {
    ...memoryCoord({ now: () => NOW }),
    kv: {
      get: async () => {
        throw new GatewayError("OVERLOADED", "the coordinator is unreachable");
      },
      set: async () => {
        throw new GatewayError("OVERLOADED", "the coordinator is unreachable");
      },
      del: async () => {},
      delPrefix: async () => {},
    },
  };

  const ops = quotaOps({
    ...deps(
      store,
      async () => report,
      () => NOW,
      down,
    ),
    logger,
  });
  const { outcomes } = await ops.refresh({ kind: "all" });

  expect(outcomes.map((o) => o.kind)).toEqual(["refreshed", "refreshed"]);
  expect(
    logger.records.filter((r) => r.msg === "quota probe coordination unavailable"),
  ).not.toHaveLength(0);
});

test("a 429 whose cooldown cannot be written is still reported as rate limited", async () => {
  // The cooldown write lives in the failure path. Letting it throw would lose
  // the outcome it was recording.
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  const unwritable: Coord = {
    ...memoryCoord({ now: () => NOW }),
    kv: {
      get: async () => null,
      set: async () => {
        throw new GatewayError("OVERLOADED", "the coordinator is unreachable");
      },
      del: async () => {},
      delPrefix: async () => {},
    },
  };

  const ops = quotaOps(
    deps(
      store,
      async () => {
        throw new GatewayError("RATE_LIMIT", "rate limited");
      },
      () => NOW,
      unwritable,
    ),
  );

  expect(await refreshOne(ops, "c1")).toEqual({
    kind: "failed",
    credentialId: "c1",
    code: "RATE_LIMIT",
  });
});
