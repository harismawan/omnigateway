import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { LimitConfig } from "@omni/ratelimit/catalog";
import type { Store, UsageSums } from "@omni/store";
import { captureLogger, memoryStore, requestLog, seedApiKey } from "@omni/testkit";
import { ApiKeyRateLimiter } from "../../src/auth/rateLimit.ts";

const T0 = 10_000_000;
const FIVE_HOURS = 5 * 60 * 60 * 1000;

/**
 * A limiter over a real store, with the one read it makes on the hot path
 * observable.
 *
 * The store is real rather than stubbed because `sumSince` is where the
 * pending-row filter and the four-column token sum live, and a fake would agree
 * with whatever this file assumed about them.
 */
async function harness(limits: LimitConfig, sumTimeoutMs = 20) {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, { limits });
  const logger = captureLogger();
  let clock = T0;
  const reads: number[] = [];
  const real = store.usage.sumSince.bind(store.usage);
  store.usage.sumSince = async (id, since) => {
    reads.push(since);
    return await real(id, since);
  };
  const limiter = new ApiKeyRateLimiter({ store, now: () => clock, logger, sumTimeoutMs });

  return {
    store,
    logger,
    limiter,
    limits,
    keyId: key.id,
    reads,
    /** Every `sumSince` a read-through issues, one per long window. */
    readThroughs: () => reads.length / 2,
    at(ms: number) {
      clock = ms;
    },
    admit: () => limiter.admit(key.id, limits, "req_test"),
    consume: () => limiter.consume(key.id, limits, "req_test"),
    /** One finished request, as `finishLog` completes it: row first, then debit. */
    async complete(usage: { tokens?: number; costUsd?: number } = {}) {
      await store.usage.append(
        requestLog({
          id: `log_${reads.length}_${clock}_${Math.random()}`,
          apiKeyId: key.id,
          at: clock,
          inputTokens: usage.tokens ?? 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: usage.costUsd ?? 0,
        }),
      );
      limiter.debit(key.id, { tokens: usage.tokens ?? 0, costUsd: usage.costUsd ?? 0 });
    },
  };
}

/** Seeds one finished row without telling the limiter, so only a read can see it. */
async function seedRow(
  store: Store,
  keyId: string,
  at: number,
  usage: { tokens?: number; costUsd?: number },
): Promise<void> {
  const tokens = usage.tokens ?? 0;
  await store.usage.append(
    requestLog({
      id: `seed_${at}_${tokens}_${usage.costUsd ?? 0}`,
      apiKeyId: keyId,
      at,
      // Split across all four classes, which are disjoint, so a sum that
      // reached for only one of them reads low here rather than agreeing.
      inputTokens: Math.floor(tokens / 4),
      outputTokens: Math.floor(tokens / 4),
      cacheReadTokens: Math.floor(tokens / 4),
      cacheWriteTokens: tokens - 3 * Math.floor(tokens / 4),
      costUsd: usage.costUsd ?? 0,
    }),
  );
}

async function denied(admit: () => Promise<unknown>): Promise<GatewayError> {
  try {
    await admit();
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error("expected the limiter to refuse the request");
}

test("a token ceiling denies at the limit and allows below it", async () => {
  const under = await harness({ tokens: { "5h": 101 } });
  await seedRow(under.store, under.keyId, T0 - 1000, { tokens: 100 });
  expect(await under.admit()).toBeInstanceOf(Function);
  under.store.close();

  const at = await harness({ tokens: { "5h": 100 } });
  await seedRow(at.store, at.keyId, T0 - 1000, { tokens: 100 });
  const error = await denied(at.admit);
  expect(error.code).toBe("RATE_LIMIT");
  at.store.close();
});

test("a spend ceiling denies at the limit and allows below it", async () => {
  const under = await harness({ spend: { "1w": 5.5 } });
  await seedRow(under.store, under.keyId, T0 - 1000, { costUsd: 5 });
  expect(await under.admit()).toBeInstanceOf(Function);
  under.store.close();

  const at = await harness({ spend: { "1w": 5 } });
  await seedRow(at.store, at.keyId, T0 - 1000, { costUsd: 5 });
  expect((await denied(at.admit)).code).toBe("RATE_LIMIT");
  at.store.close();
});

test("a concurrency ceiling denies while slots are held and allows once one is freed", async () => {
  const { limiter, keyId, admit, store } = await harness({ concurrency: 2 });

  const first = await admit();
  const second = await admit();
  expect(limiter.inFlight(keyId)).toBe(2);
  expect((await denied(admit)).code).toBe("RATE_LIMIT");

  first();
  expect(limiter.inFlight(keyId)).toBe(1);
  const third = await admit();
  expect(limiter.inFlight(keyId)).toBe(2);

  // Idempotent: a release that arrives twice frees one slot, not two.
  second();
  second();
  third();
  expect(limiter.inFlight(keyId)).toBe(0);
  store.close();
});

test("a long window counts the store sum plus what has been debited since it was read", async () => {
  const { store, keyId, limiter, admit, at } = await harness({ tokens: { "5h": 100 } });
  await seedRow(store, keyId, T0 - 1000, { tokens: 40 });

  at(T0);
  expect(await admit()).toBeInstanceOf(Function);

  // A finished request the store has not been asked about again. Only the
  // in-memory delta knows about it, and without it the key reads as 40.
  limiter.debit(keyId, { tokens: 60, costUsd: 0 });

  expect((await denied(admit)).code).toBe("RATE_LIMIT");
  store.close();
});

test("the store sum is reused inside the cache TTL and read again after it", async () => {
  // A ceiling nothing reaches, so every admission is allowed and the only thing
  // under test is how often the store is asked.
  const { store, keyId, admit, at, readThroughs } = await harness({ tokens: { "5h": 1_000_000 } });
  await seedRow(store, keyId, T0 - 1000, { tokens: 40 });

  at(T0);
  await admit();
  expect(readThroughs()).toBe(1);

  at(T0 + 29_999);
  await admit();
  expect(readThroughs()).toBe(1);

  // The TTL is a half-open interval like every window here: thirty seconds old
  // is stale, and not a tick before.
  at(T0 + 30_000);
  await admit();
  expect(readThroughs()).toBe(2);
  store.close();
});

/**
 * The direction of the composition's one inaccuracy, pinned.
 *
 * Events that age out of a window between the cached read and now are not
 * subtracted, so the count runs high and never low. A limiter whose error ran
 * the other way could be walked through by timing the cache refresh, which is a
 * property an attacker can discover and an operator cannot.
 */
test("a window that aged out inside the TTL still counts, so the error runs high", async () => {
  const { store, keyId, admit, at } = await harness({ tokens: { "5h": 100 } });
  // Ages out of the five-hour window ten seconds after T0.
  await seedRow(store, keyId, T0 - FIVE_HOURS + 10_000, { tokens: 60 });
  await seedRow(store, keyId, T0, { tokens: 60 });

  at(T0);
  expect((await denied(admit)).code).toBe("RATE_LIMIT");

  // Twenty seconds on, the older row has left the window and the true sum is
  // 60. The cached read still holds 120, so the key is refused early — the
  // safe direction, and bounded by the TTL.
  at(T0 + 20_000);
  expect((await denied(admit)).code).toBe("RATE_LIMIT");

  // And it recovers on the next read rather than staying wrong.
  at(T0 + 30_000);
  expect(await admit()).toBeInstanceOf(Function);
  store.close();
});

/**
 * The other half of the same direction: a row committed while a read was in
 * flight lands in both the sum and the delta and is counted twice, rather than
 * falling between the two and being counted nowhere.
 */
test("a debit recorded at the instant of a read survives the prune", async () => {
  const { store, keyId, limiter, admit, at } = await harness({ tokens: { "5h": 100 } });

  at(T0);
  expect(await admit()).toBeInstanceOf(Function);

  // The row lands, then the debit is recorded at the same instant the next
  // read is issued at. The read already sees the row; keeping the debit as well
  // double-counts it, which is the tolerated error.
  at(T0 + 30_000);
  await seedRow(store, keyId, T0 + 30_000, { tokens: 60 });
  limiter.debit(keyId, { tokens: 60, costUsd: 0 });

  expect((await denied(admit)).code).toBe("RATE_LIMIT");
  store.close();
});

test("a debit near a ceiling reads through eagerly instead of waiting out the TTL", async () => {
  const { store, keyId, limiter, admit, at, readThroughs } = await harness({
    tokens: { "5h": 100 },
  });

  at(T0);
  await admit();
  expect(readThroughs()).toBe(1);

  // Comfortably clear of the ceiling: the cache is left alone.
  at(T0 + 1_000);
  limiter.debit(keyId, { tokens: 50, costUsd: 0 });
  at(T0 + 2_000);
  await admit();
  expect(readThroughs()).toBe(1);

  // Inside the last tenth of the ceiling, where precision is about to matter.
  at(T0 + 3_000);
  await seedRow(store, keyId, T0 + 3_000, { tokens: 40 });
  limiter.debit(keyId, { tokens: 40, costUsd: 0 });
  at(T0 + 4_000);
  await admit();
  expect(readThroughs()).toBe(2);
  store.close();
});

test("a failing store read serves the request, logs it, and still enforces 1m and concurrency", async () => {
  const limits: LimitConfig = { requests: { "1m": 2 }, concurrency: 1, tokens: { "5h": 1 } };
  const { store, keyId, limiter, logger, admit, at } = await harness(limits);
  // Enough recorded usage that an answered read would refuse every request
  // below, so an assertion here cannot pass by the counters being empty.
  await seedRow(store, keyId, T0 - 1000, { tokens: 5000 });
  store.usage.sumSince = async () => {
    throw new Error("database is locked");
  };

  at(T0);
  const first = await admit();
  expect(logger.records).toContainEqual(
    expect.objectContaining({
      level: "warn",
      msg: "rate limit counters unavailable",
      fields: expect.objectContaining({ apiKeyId: keyId, requestId: "req_test" }),
    }),
  );
  expect(logger.lines.join("\n")).not.toContain("5000");

  // Concurrency is pure memory and never reached the store, so it enforces
  // exactly through the fault. This is the whole justification for failing
  // open on the long windows.
  expect((await denied(admit)).code).toBe("RATE_LIMIT");

  first();
  const second = await admit();
  second();
  // Two requests are on the ring now, and `requests` at 1m is exact whatever
  // the store is doing.
  expect(limiter.inFlight(keyId)).toBe(0);
  expect((await denied(admit)).code).toBe("RATE_LIMIT");

  at(T0 + 60_000);
  expect(await admit()).toBeInstanceOf(Function);
  store.close();
});

test("a store read that never answers is abandoned rather than held open", async () => {
  const { store, admit, at, logger } = await harness({ requests: { "1m": 1, "5h": 1 } }, 20);
  store.usage.sumSince = () => new Promise<UsageSums>(() => {});

  at(T0);
  expect(await admit()).toBeInstanceOf(Function);
  expect(logger.records.map((record) => record.msg)).toContain("rate limit counters unavailable");
  // The 1m ring is untouched by the fault, so the next request is still refused.
  expect((await denied(admit)).code).toBe("RATE_LIMIT");
  store.close();
});

test("count_tokens consumes requests and never tokens, spend, or a concurrency slot", async () => {
  const limits: LimitConfig = {
    requests: { "1m": 2 },
    tokens: { "5h": 1 },
    spend: { "5h": 0.01 },
    concurrency: 1,
  };
  const { store, keyId, limiter, consume, at } = await harness(limits);
  // Far past both budgets, and past the concurrency ceiling if it applied.
  await seedRow(store, keyId, T0 - 1000, { tokens: 5000, costUsd: 40 });

  at(T0);
  await consume();
  await consume();
  expect(limiter.inFlight(keyId)).toBe(0);

  // Only `requests` at 1m, which two counts have now filled.
  expect((await denied(consume)).code).toBe("RATE_LIMIT");
  store.close();
});

test("an unlimited key allocates nothing and holds no gauge", async () => {
  const { keyId, limiter, admit, reads, store } = await harness({});
  const release = await admit();
  expect(limiter.inFlight(keyId)).toBe(0);
  expect(reads).toHaveLength(0);
  release();
  store.close();
});
