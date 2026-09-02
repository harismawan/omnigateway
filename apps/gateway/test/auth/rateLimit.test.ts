import { expect, test } from "bun:test";
import { memoryCoord } from "@omni/coord";
import { GatewayError } from "@omni/ir";
import type { LimitConfig } from "@omni/ratelimit/catalog";
import type { Store } from "@omni/store";
import { captureLogger, memoryStore, requestLog, seedApiKey } from "@omni/testkit";
import { ApiKeyRateLimiter } from "../../src/auth/rateLimit.ts";

/** Minute-aligned, so a bucket's edge is where the arithmetic says it is. */
const T0 = 10_020_000;
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const _ONE_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * A limiter over a real store, with the one read it makes — the seed —
 * observable.
 *
 * The store is real rather than stubbed because `sumBuckets` is where the
 * pending-row filter and the four-column token sum live, and a fake would agree
 * with whatever this file assumed about them.
 */
async function harness(limits: LimitConfig, coord = memoryCoord()) {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, { limits });
  const logger = captureLogger();
  let clock = T0;
  const reads: number[] = [];
  const real = store.usage.sumBuckets.bind(store.usage);
  store.usage.sumBuckets = async (id, since, grain) => {
    reads.push(since);
    return await real(id, since, grain);
  };
  const limiter = new ApiKeyRateLimiter({ store, now: () => clock, logger, coord });

  return {
    store,
    logger,
    limiter,
    limits,
    keyId: key.id,
    reads,
    /** Every seed issued, one per long window. */
    readThroughs: () => reads.length / 2,
    at(ms: number) {
      clock = ms;
    },
    /** The concurrency release only; the headroom has its own tests. */
    admit: async () => (await limiter.admit(key.id, limits, "req_test")).release,
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

/**
 * How many of `count` checks started together were admitted.
 *
 * Every call is started before any of them is awaited, which is the arrangement
 * a burst of concurrent requests actually produces and the one a check that
 * recorded only after its store read could not survive: each call yielded on the
 * read, so all of them judged the same pre-burst snapshot and all of them were
 * admitted.
 */
async function burst(count: number, call: () => Promise<unknown>): Promise<number> {
  const settled = await Promise.allSettled(Array.from({ length: count }, () => call()));
  for (const result of settled) {
    if (result.status === "rejected" && !(result.reason instanceof GatewayError))
      throw result.reason;
  }
  return settled.filter((result) => result.status === "fulfilled").length;
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
  expect(await limiter.inFlight(keyId)).toBe(2);
  expect((await denied(admit)).code).toBe("RATE_LIMIT");

  first();
  expect(await limiter.inFlight(keyId)).toBe(1);
  const third = await admit();
  expect(await limiter.inFlight(keyId)).toBe(2);

  // Idempotent: a release that arrives twice frees one slot, not two.
  second();
  second();
  third();
  expect(await limiter.inFlight(keyId)).toBe(0);
  store.close();
});

/**
 * A check has to claim its place before it can yield, or a burst never sees
 * itself.
 *
 * Ten requests arriving together against a ceiling of three were ten
 * admissions: each read the ring, yielded, and recorded only afterwards, so
 * every one of them judged the same pre-burst snapshot. Asserted at exactly the
 * ceiling rather than at "fewer than ten", because a claim that half works is
 * still a hole.
 */
test("a burst against a 1m ceiling admits exactly the ceiling", async () => {
  const { limiter, keyId, limits, store } = await harness({ requests: { "1m": 3 } });
  expect(await burst(10, () => limiter.admit(keyId, limits, "req_test"))).toBe(3);
  store.close();
});

/** The same hole, in the dimension that exists to bound exactly this burst. */
test("a burst against a concurrency ceiling admits exactly the ceiling", async () => {
  const { limiter, keyId, limits, store } = await harness({ concurrency: 3 });
  expect(await burst(8, () => limiter.admit(keyId, limits, "req_test"))).toBe(3);
  expect(await limiter.inFlight(keyId)).toBe(3);
  store.close();
});

/**
 * The other half of the same bug, and the half that errs the wrong way.
 *
 * A check suspended before its claim had raised nothing, so `cleanup` read its
 * state as idle and dropped it, and the check then recorded onto an entry no
 * longer in the map. Four requests admitted under a ceiling nothing reaches left
 * the gauge reading one, and a gauge that under-counts is a ceiling nobody is
 * held to.
 */
test("a burst under a generous ceiling leaves the gauge at the true count", async () => {
  const { limiter, keyId, limits, store } = await harness({ concurrency: 10 });
  expect(await burst(4, () => limiter.admit(keyId, limits, "req_test"))).toBe(4);
  expect(await limiter.inFlight(keyId)).toBe(4);
  store.close();
});

/**
 * A refusal gives back every part of what its check claimed.
 *
 * Refused on `concurrency` while `requests` still has room, which is the only
 * arrangement where both halves of the rollback are visible: the gauge must read
 * two rather than eight, and the ring must hold the two admissions rather than
 * all eight attempts. A leaked claim is worse than the race it closed — no
 * window expires a gauge, so six stranded slots lock the key out for good.
 */
test("a refused request rolls back both the gauge and the ring", async () => {
  const { limiter, keyId, limits, store } = await harness({
    requests: { "1m": 100 },
    concurrency: 2,
  });

  const settled = await Promise.allSettled(
    Array.from({ length: 8 }, () => limiter.admit(keyId, limits, "req_test")),
  );
  const admitted = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  expect(admitted).toHaveLength(2);
  expect(await limiter.inFlight(keyId)).toBe(2);

  for (const admission of admitted) admission.release();
  expect(await limiter.inFlight(keyId)).toBe(0);

  // The ring, read off the next request's headroom: the two stamps the
  // admissions recorded, and nothing at all from the six refusals.
  const next = await limiter.admit(keyId, limits, "req_test");
  expect(next.headroom.requests?.used).toBe(2);
  store.close();
});

/** `count_tokens` claims a ring slot the same way, and had the same hole. */
test("a burst of count_tokens checks consumes exactly the ceiling", async () => {
  const { limiter, keyId, limits, store } = await harness({ requests: { "1m": 3 } });
  expect(await burst(10, () => limiter.consume(keyId, limits, "req_test"))).toBe(3);
  store.close();
});

test("a long window counts the seeded store sum plus what has been debited since", async () => {
  const { store, keyId, limiter, admit, at } = await harness({ tokens: { "5h": 100 } });
  await seedRow(store, keyId, T0 - 1000, { tokens: 40 });

  at(T0);
  expect(await admit()).toBeInstanceOf(Function);

  // A finished request the store has not been asked about again. Only the
  // buckets know about it, and without the debit the key reads as 40.
  limiter.debit(keyId, { tokens: 60, costUsd: 0 });

  expect((await denied(admit)).code).toBe("RATE_LIMIT");
  store.close();
});

/**
 * A long `requests` ceiling is enforced by the debit, not by the ring.
 *
 * `requests` at `1m` is claimed at admission, but at `5h` and `1w` the count is
 * the buckets — and the buckets are debited on completion, so a long window
 * sees a request when `finishLog` debits it. A debit carrying no request at all
 * would leave the ceiling reading zero forever.
 */
test("a long requests ceiling is reached because every debit carries its request", async () => {
  const { store, admit, complete, at } = await harness({ requests: { "5h": 3 } });
  let admitted = 0;
  for (let i = 0; i < 10; i++) {
    at(T0 + i * 1_000);
    let release: (() => void) | null = null;
    try {
      release = await admit();
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      continue;
    }
    admitted++;
    // Row first, then the debit, which is the order `finishLog` runs them in.
    await complete();
    release();
  }
  expect(admitted).toBe(3);
  store.close();
});

test("the store seeds a key once and is not asked again while the buckets live", async () => {
  // A ceiling nothing reaches, so every admission is allowed and the only thing
  // under test is how often the store is asked.
  const { store, keyId, admit, at, readThroughs } = await harness({ tokens: { "5h": 1_000_000 } });
  await seedRow(store, keyId, T0 - 1000, { tokens: 40 });

  at(T0);
  (await admit())();
  expect(readThroughs()).toBe(1);
  (await admit())();
  at(T0 + 3_600_000);
  (await admit())();
  expect(readThroughs()).toBe(1);
  store.close();
});

/**
 * A window slides at its grain, and the trailing bucket counts until the whole
 * of it has aged out. A row exactly five hours old is over-counted for up to a
 * minute, which is the direction the composition may err — under-counting is
 * the one it must never take.
 */
test("a trailing bucket counts until its whole grain has aged out", async () => {
  const { store, keyId, admit, at } = await harness({ tokens: { "5h": 100 } });
  await seedRow(store, keyId, T0 - FIVE_HOURS, { tokens: 100 });

  at(T0);
  expect((await denied(admit)).code).toBe("RATE_LIMIT");
  at(T0 + 59_999);
  expect((await denied(admit)).code).toBe("RATE_LIMIT");
  at(T0 + 60_000);
  expect(await admit()).toBeInstanceOf(Function);
  store.close();
});

/**
 * A debit before the key is seeded is ignored, and the seed that follows reads
 * the row instead — never both, which would count the request twice, and never
 * neither, which is the error this design must not make.
 */
test("a debit before the seed is counted once, by the seed", async () => {
  const { store, keyId, admit, complete, at } = await harness({ tokens: { "5h": 100 } });
  await seedRow(store, keyId, T0 - 1000, { tokens: 40 });
  at(T0);
  // A debit that installed its own picture would read 60 and admit; one
  // counted by both the debit and the seed would read 160 — allowed, but the
  // next assertion at 99 catches it.
  await complete({ tokens: 60 });
  expect((await denied(admit)).code).toBe("RATE_LIMIT");
  store.close();
});

test("a debit before the seed is not counted twice", async () => {
  const { store, keyId, admit, complete, at } = await harness({ tokens: { "5h": 100 } });
  await seedRow(store, keyId, T0 - 1000, { tokens: 40 });
  at(T0);
  await complete({ tokens: 30 });
  // 70 in the store; a double count would read 100 and refuse.
  expect(await admit()).toBeInstanceOf(Function);
  store.close();
});

test("a failing store read serves the request, logs it, and still enforces 1m and concurrency", async () => {
  const limits: LimitConfig = { requests: { "1m": 2 }, concurrency: 1, tokens: { "5h": 1 } };
  const { store, keyId, limiter, logger, admit, at } = await harness(limits);
  // Enough recorded usage that an answered read would refuse every request
  // below, so an assertion here cannot pass by the counters being empty.
  await seedRow(store, keyId, T0 - 1000, { tokens: 5000 });
  store.usage.sumBuckets = async () => {
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

  // Concurrency never reached the store, so it enforces exactly through the
  // fault. This is the whole justification for failing open on the long
  // windows.
  expect((await denied(admit)).code).toBe("RATE_LIMIT");

  first();
  const second = await admit();
  second();
  // Two requests are on the ring now, and `requests` at 1m is exact whatever
  // the store is doing.
  expect(await limiter.inFlight(keyId)).toBe(0);
  expect((await denied(admit)).code).toBe("RATE_LIMIT");

  at(T0 + 60_000);
  expect(await admit()).toBeInstanceOf(Function);
  store.close();
});

/**
 * Two processes over one store and one coordinator. The second never reads
 * the store for what the first debited: the buckets carry it, which is the
 * exactness the per-process cache could not have.
 */
test("a long window is exact across limiters sharing a coord", async () => {
  const coord = memoryCoord();
  const a = await harness({ tokens: { "5h": 100 } }, coord);
  const b = new ApiKeyRateLimiter({ store: a.store, now: () => T0, coord });
  const admitB = () => b.admit(a.keyId, a.limits, "req_b");

  a.at(T0);
  (await a.admit())();
  await a.complete({ tokens: 60 });
  // B is seeded already — A's admit seeded the shared buckets — and A's
  // debit is in them, so B reads 60 with no store read of its own.
  (await admitB()).release();
  expect(a.readThroughs()).toBe(1);
  await a.complete({ tokens: 50 });
  expect((await denied(admitB)).code).toBe("RATE_LIMIT");
  expect(a.readThroughs()).toBe(1);
  a.store.close();
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
  expect(await limiter.inFlight(keyId)).toBe(0);

  // Only `requests` at 1m, which two counts have now filled.
  expect((await denied(consume)).code).toBe("RATE_LIMIT");
  store.close();
});

test("an unlimited key allocates nothing and holds no gauge", async () => {
  const { keyId, limiter, admit, reads, store } = await harness({});
  const release = await admit();
  expect(await limiter.inFlight(keyId)).toBe(0);
  expect(reads).toHaveLength(0);
  release();
  store.close();
});
