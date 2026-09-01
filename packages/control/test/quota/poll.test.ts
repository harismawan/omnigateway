import { beforeEach, expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { nodeHttpClient, parseOpenAIUsage } from "@omni/providers";
import { type CredentialSecrets, type Store, sameWindow, type UsageSecrets } from "@omni/store";
import { captureLogger, memoryStore, seedCredential } from "@omni/testkit";
import type { OAuthProvider, UsageReport } from "../../src/oauth/types.ts";
import { poll, probe, RATE_LIMIT_COOLDOWN_MS, resetQuotaCooldowns } from "../../src/quota/poll.ts";

const NOW = 1_000_000;

beforeEach(() => {
  // Cooldowns are process-local state shared across tests in this file.
  resetQuotaCooldowns();
});

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
    { windowType: "fiveHour", used: 62, limit: 100, resetsAt: NOW + 3_600_000, windowMs: null },
    { windowType: "weekly", used: 18, limit: 100, resetsAt: NOW + 86_400_000, windowMs: null },
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
    windowMs: null,
  });
});

test("a reported window duration reaches the stored snapshot", async () => {
  // The bucket name is one of three; the duration the provider declared is not.
  // Losing it here would put the correction back where it started.
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  await poll(
    deps(store, async () => ({
      windows: [
        { windowType: "fiveHour", used: 1, limit: 100, resetsAt: NOW + 1, windowMs: 10_800_000 },
        { windowType: "weekly", used: 2, limit: 100, resetsAt: NOW + 2, windowMs: null },
      ],
    })),
  );

  const rows = (await store.credentials.listQuota()).sort((a, b) =>
    a.windowType.localeCompare(b.windowType),
  );
  expect(rows.map((r) => r.windowMs)).toEqual([10_800_000, null]);
  expect(
    (await store.credentials.listQuotaSamples({ since: 0, until: NOW + 1 })).map((s) => s.windowMs),
  ).toEqual([10_800_000, null]);
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
      windowMs: null,
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

/**
 * Observed in production: `quota probe failed … code=INTERNAL reason=`.
 *
 * The probe's transport failed with an `AggregateError`, which keeps its detail
 * in `errors` and has no message of its own, so the field that exists to say why
 * the probe failed said nothing at all.
 */
test("names a probe failure that carries no message", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  const logger = captureLogger();

  await poll({
    ...deps(store, async () => {
      throw new AggregateError([new Error("connect ECONNREFUSED 2607:6bc0::10:443")]);
    }),
    logger,
  });

  const failures = logger.records.filter((record) => record.msg === "quota probe failed");
  expect(failures).toHaveLength(1);
  expect(failures[0]?.fields?.reason).toBe("AggregateError");
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

/**
 * Codex as it actually answers: a whole-second countdown, never an instant.
 *
 * `resetAtOf` turns that into an absolute reset as `now + seconds * 1000`, and
 * `now` moves a poll interval between probes, so the derived instant lands a
 * few hundred milliseconds off the last one every single time even though the
 * window is standing perfectly still.
 */
function codexPayload(trueReset: number, at: number, usedPercent: number): unknown {
  return {
    rate_limit: {
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 18_000,
        reset_after_seconds: Math.floor((trueReset - at) / 1000),
      },
      secondary_window: null,
    },
  };
}

/** Probe instants a poll interval apart, never landing on a second boundary. */
const PROBES = [NOW, NOW + 300_137, NOW + 600_402, NOW + 899_615, NOW + 1_200_988];

test("an idle relative-reset account writes one sample, not one per poll", async () => {
  // The production scenario in full: five probes of an untouched Codex account
  // through the real payload parser. Comparing the derived reset exactly makes
  // every poll look like a new window, which is a row per poll per window per
  // credential for as long as the account stays connected — roughly 288 a day
  // for an account doing nothing at all.
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  const trueReset = NOW + 3 * 3_600_000;
  let at = NOW;
  const usage = async () => parseOpenAIUsage(codexPayload(trueReset, at, 40), at);

  for (const probeAt of PROBES) {
    at = probeAt;
    await poll({ ...deps(store, usage), now: () => at });
  }

  const samples = await store.credentials.listQuotaSamples({
    since: 0,
    until: Number.MAX_SAFE_INTEGER,
  });
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ observedAt: NOW, used: 40 });

  // Liveness still lives in the snapshot: the probe ran five times and the
  // newest reading says so, even though the series has nothing to add.
  const rows = await store.credentials.listQuota();
  expect(rows[0]?.observedAt).toBe(PROBES[PROBES.length - 1]);
});

test("an active relative-reset account charts as one window, not one point per poll", async () => {
  // The same jitter with `used` moving. Every reading is genuinely new, so every
  // reading is retained — but they are all readings of one window, and the reset
  // they carry must stay close enough for the chart to hold them together. A
  // segment per sample draws a single-point `stepAfter` line each, which renders
  // as nothing while still suppressing the "not yet observed" note.
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  const trueReset = NOW + 3 * 3_600_000;
  let at = NOW;
  let used = 40;
  const usage = async () => parseOpenAIUsage(codexPayload(trueReset, at, used), at);

  for (const probeAt of PROBES) {
    at = probeAt;
    used += 5;
    await poll({ ...deps(store, usage), now: () => at });
  }

  const samples = await store.credentials.listQuotaSamples({
    since: 0,
    until: Number.MAX_SAFE_INTEGER,
  });
  expect(samples.map((s) => s.used)).toEqual([45, 50, 55, 60, 65]);

  // The resets do differ — that is the whole defect — and no two adjacent
  // readings may be told apart by it. `sameWindow` is the single definition the
  // chart splits on, so this is the same question the console asks.
  const resets = samples.map((s) => s.resetsAt);
  expect(new Set(resets).size).toBeGreaterThan(1);
  for (let i = 1; i < resets.length; i += 1) {
    expect(sameWindow(resets[i - 1] ?? null, resets[i] ?? null)).toBe(true);
  }
});
