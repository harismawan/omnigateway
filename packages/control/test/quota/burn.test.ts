import { expect, test } from "bun:test";
import type { QuotaWindow, RequestLog, Store } from "@omni/store";
import { memoryStore, quota, requestLog, seedCredential } from "@omni/testkit";
import { type BurnInput, burnEstimates, burnFor } from "../../src/quota/burn.ts";

const HOUR = 3_600_000;
const OBSERVED = 1_700_000_000_000;
const POLL_MS = 300_000;
/** `quotaStaleAfterMs(300_000)` — three poll intervals. */
const STALE_AFTER = 900_000;

/** A five-hour window read two hours in, with three hours still to run. */
function window(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return quota({
    credentialId: "c1",
    windowType: "fiveHour",
    used: 100,
    limit: 1_000,
    resetsAt: OBSERVED + 3 * HOUR,
    observedAt: OBSERVED,
    ...overrides,
  });
}

function at(now: number, gatewayTokens: number | null = null): BurnInput {
  return { now, pollIntervalMs: POLL_MS, gatewayTokens };
}

test("rate and exhaustion are derived from the reading alone", () => {
  const estimate = burnFor(window(), at(OBSERVED));

  expect(estimate).toEqual({
    credentialId: "c1",
    windowType: "fiveHour",
    // resetsAt minus the nominal five hours.
    windowStartsAt: OBSERVED - 2 * HOUR,
    // 100 units over two hours.
    ratePerHour: 50,
    // 900 left at 50/h is eighteen hours away.
    exhaustsAt: OBSERVED + 18 * HOUR,
    survives: true,
    gatewayRatePerHour: null,
    stale: false,
  });
});

test("survives is false when the estimate falls short of the reset", () => {
  const estimate = burnFor(window({ used: 800 }), at(OBSERVED));

  expect(estimate.ratePerHour).toBe(400);
  expect(estimate.exhaustsAt).toBe(OBSERVED + HOUR / 2);
  expect(estimate.survives).toBe(false);
});

test("survives is true when the estimate falls past the reset", () => {
  // 300 used in two hours is 150/h; the remaining 700 outlast the three hours
  // the window still has to run.
  const estimate = burnFor(window({ used: 300, limit: 1_000 }), at(OBSERVED));

  expect(estimate.exhaustsAt).toBeGreaterThan(OBSERVED + 3 * HOUR);
  expect(estimate.survives).toBe(true);
});

test("a window with no limit reports no exhaustion estimate", () => {
  const estimate = burnFor(window({ limit: null }), at(OBSERVED));

  expect(estimate.exhaustsAt).toBeNull();
  expect(estimate.stale).toBe(false);
});

test("a window with no reset reports no rate at all, rather than zero", () => {
  const estimate = burnFor(window({ resetsAt: null }), at(OBSERVED, 6_000));

  expect(estimate.windowStartsAt).toBeNull();
  expect(estimate.ratePerHour).toBeNull();
  expect(estimate.exhaustsAt).toBeNull();
  expect(estimate.gatewayRatePerHour).toBeNull();
});

test("a window that just rolled over reads as not burning rather than as infinite", () => {
  // resetsAt exactly one nominal window out puts the start at the reading.
  const fresh = burnFor(window({ resetsAt: OBSERVED + 5 * HOUR, used: 0 }), at(OBSERVED));
  expect(fresh.ratePerHour).toBe(0);
  expect(fresh.exhaustsAt).toBeNull();
  expect(fresh.survives).toBe(true);

  // A reset further out than the window is long puts the start in the future.
  const ahead = burnFor(window({ resetsAt: OBSERVED + 6 * HOUR, used: 10 }), at(OBSERVED));
  expect(ahead.ratePerHour).toBe(0);
  expect(ahead.exhaustsAt).toBeNull();
});

test("a window with nothing used yet reports a zero rate and no estimate", () => {
  const estimate = burnFor(window({ used: 0 }), at(OBSERVED));

  expect(estimate.ratePerHour).toBe(0);
  expect(estimate.exhaustsAt).toBeNull();
  expect(estimate.survives).toBe(true);
});

test("a reading nobody believes is suppressed rather than extrapolated", () => {
  const estimate = burnFor(window(), at(OBSERVED + STALE_AFTER + 1, 6_000));

  expect(estimate).toEqual({
    credentialId: "c1",
    windowType: "fiveHour",
    windowStartsAt: null,
    ratePerHour: null,
    exhaustsAt: null,
    survives: null,
    gatewayRatePerHour: null,
    stale: true,
  });
});

test("a window never observed at all is suppressed", () => {
  const estimate = burnFor(window({ observedAt: 0 }), at(OBSERVED));

  expect(estimate.stale).toBe(true);
  expect(estimate.ratePerHour).toBeNull();
});

test("a provider-reported duration overrides the nominal one, and its absence falls back", () => {
  const row = window({ resetsAt: OBSERVED + HOUR, used: 100 });

  // Three hours long: the window began two hours before the reading.
  expect(burnFor({ ...row, windowMs: 3 * HOUR }, at(OBSERVED)).windowStartsAt).toBe(
    OBSERVED - 2 * HOUR,
  );
  expect(burnFor({ ...row, windowMs: 3 * HOUR }, at(OBSERVED)).ratePerHour).toBe(50);

  // Nominal five hours: the window began four hours before the reading.
  expect(burnFor(row, at(OBSERVED)).windowStartsAt).toBe(OBSERVED - 4 * HOUR);
  expect(burnFor(row, at(OBSERVED)).ratePerHour).toBe(25);
});

test("the estimate is invariant under now, and only the staleness verdict flips", () => {
  const row = window();
  const fresh = [0, 1_000, POLL_MS, 2 * POLL_MS, STALE_AFTER].map((ahead) =>
    burnFor(row, at(OBSERVED + ahead, 6_000)),
  );

  // Byte-identical across five reads spanning three poll intervals: the
  // numerator and the denominator are both as of `observedAt`, so nothing here
  // may sag between probes.
  for (const estimate of fresh) {
    expect(estimate.windowStartsAt).toBe(OBSERVED - 2 * HOUR);
    expect(estimate.ratePerHour).toBe(50);
    expect(estimate.exhaustsAt).toBe(OBSERVED + 18 * HOUR);
    expect(estimate.gatewayRatePerHour).toBe(3_000);
    expect(estimate.stale).toBe(false);
    expect(estimate).toEqual(fresh[0] as typeof estimate);
  }

  const past = burnFor(row, at(OBSERVED + STALE_AFTER + 1, 6_000));
  expect(past.stale).toBe(true);
});

async function log(store: Store, id: string, at: number, overrides: Partial<RequestLog> = {}) {
  await store.usage.append(requestLog({ id, at, credentialId: "c1", ...overrides }));
}

test("the gateway rate counts every token class this credential spent in the span", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await seedCredential(store, { id: "c2" });
  const row = window();
  const start = OBSERVED - 2 * HOUR;

  await log(store, "in", start + HOUR, {
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 400,
    cacheWriteTokens: 300,
  });
  // Another credential's traffic, before the window, and after the reading.
  await log(store, "other", start + HOUR, { credentialId: "c2", inputTokens: 9_000 });
  await log(store, "before", start - 1, { inputTokens: 9_000 });
  await log(store, "after", OBSERVED + 1, { inputTokens: 9_000 });

  // Read one poll interval after the snapshot: the span ends at the reading,
  // not at the clock, so the two rates cover the same hours.
  const [estimate] = await burnEstimates({ store, now: () => OBSERVED + POLL_MS }, [row], POLL_MS);

  // 1000 tokens over the same two hours the provider rate divides by.
  expect(estimate?.gatewayRatePerHour).toBe(500);
  expect(estimate?.ratePerHour).toBe(50);
});

test("a credential with no gateway traffic in the span reports a zero gateway rate", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });

  const [estimate] = await burnEstimates({ store, now: () => OBSERVED }, [window()], POLL_MS);

  expect(estimate?.gatewayRatePerHour).toBe(0);
});

test("in-flight requests are left out of the gateway rate", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await store.usage.begin(
    requestLog({ id: "pending", at: OBSERVED - HOUR, credentialId: "c1", inputTokens: 9_000 }),
  );

  const [estimate] = await burnEstimates({ store, now: () => OBSERVED }, [window()], POLL_MS);

  expect(estimate?.gatewayRatePerHour).toBe(0);
});

test("a snapshot with no retained samples still yields an estimate", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await store.credentials.saveQuota([window()]);
  expect(
    await store.credentials.listQuotaSamples({ since: 0, until: OBSERVED + HOUR }),
  ).not.toHaveLength(0);
  // The estimate must not consult them either way.
  store.credentials.listQuotaSamples = async () => {
    throw new Error("the estimate must not read the sample series");
  };

  const [estimate] = await burnEstimates(
    { store, now: () => OBSERVED },
    await store.credentials.listQuota(),
    POLL_MS,
  );

  expect(estimate?.ratePerHour).toBe(50);
  expect(estimate?.exhaustsAt).toBe(OBSERVED + 18 * HOUR);
});
