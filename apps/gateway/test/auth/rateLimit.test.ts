import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { LimitConfig } from "@omni/ratelimit/catalog";
import type { Store } from "@omni/store";
import { captureLogger, memoryStore, requestLog, seedApiKey } from "@omni/testkit";
import { ApiKeyRateLimiter, type Debit, MAX_DEBITS, trimDebits } from "../../src/auth/rateLimit.ts";

const T0 = 10_000_000;
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * A limiter over a real store, with the one read it makes on the hot path
 * observable.
 *
 * The store is real rather than stubbed because `sumSince` is where the
 * pending-row filter and the four-column token sum live, and a fake would agree
 * with whatever this file assumed about them.
 */
async function harness(limits: LimitConfig) {
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
  const limiter = new ApiKeyRateLimiter({ store, now: () => clock, logger });

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
  expect(limiter.inFlight(keyId)).toBe(3);
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
  expect(limiter.inFlight(keyId)).toBe(4);
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
  expect(limiter.inFlight(keyId)).toBe(2);

  for (const admission of admitted) admission.release();
  expect(limiter.inFlight(keyId)).toBe(0);

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

/**
 * A long `requests` ceiling is enforced by the debit, not by the ring.
 *
 * `requests` at `1m` is claimed at admission, but at `5h` and `1w` the count is
 * `sumSince` plus the delta — and `sumSince` counts committed rows only, so a
 * long window sees a request when `finishLog` debits it. Ten requests inside one
 * cache TTL is the arrangement that separates the two: the store sum is read
 * once and then reused, so the delta is the only thing that moves, and a debit
 * carrying no request at all leaves the ceiling reading zero forever. Asserted
 * at exactly the ceiling rather than at "fewer than ten", because the debit is
 * also what trips the eager read-through that turns the third admission into the
 * refusal of the fourth.
 */
test("a long requests ceiling is reached inside one cache TTL, because every debit carries its request", async () => {
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

/**
 * Two read-throughs in flight at once, resolving in the wrong order.
 *
 * Nothing holds a lock across the yield, so an older read can come back after a
 * newer one — and the older one used to overwrite the newer sums *after* the
 * newer had already pruned the delta covering the difference. The usage between
 * the two reads is then counted in neither place, and the cache it left behind
 * is believed for the rest of its TTL. Under-counting is the one direction this
 * design must never take.
 *
 * Not reachable through `bun:sqlite`, whose reads settle in the same tick — but
 * reachable for any decorated or genuinely async store, and this file decorates
 * `sumSince` a few lines up.
 */
test("a store read that resolves behind a newer one is discarded rather than installed", async () => {
  const { store, keyId, limiter, limits, at } = await harness({ tokens: { "5h": 100 } });
  const real = store.usage.sumSince.bind(store.usage);
  /** One release per issued read, so the test chooses the order they land in. */
  const gates: Array<() => void> = [];
  store.usage.sumSince = async (id, since) => {
    // Read now and deliver later: the point is a read that answered for an
    // earlier instant, not one that ran against a later store.
    const sums = await real(id, since);
    await new Promise<void>((resolve) => gates.push(resolve));
    return sums;
  };

  // The older read, issued while the window is empty.
  at(T0);
  const older = limiter.admit(keyId, limits, "req_older");
  await Bun.sleep(0);

  // Usage the older read cannot have seen, recorded as `finishLog` records it.
  at(T0 + 2_000);
  await seedRow(store, keyId, T0 + 2_000, { tokens: 120 });
  limiter.debit(keyId, { tokens: 120, costUsd: 0 });

  // The newer read, which does see it.
  at(T0 + 5_000);
  const newer = limiter.admit(keyId, limits, "req_newer");
  await Bun.sleep(0);
  expect(gates).toHaveLength(4);

  // The newer pair lands first and prunes the delta it has absorbed; the older
  // pair lands second, with sums from before any of it happened.
  for (const gate of gates.slice(2)) gate();
  await Promise.allSettled([newer]);
  for (const gate of gates.slice(0, 2)) gate();
  await Promise.allSettled([older]);

  // 120 tokens against a ceiling of 100, and no read is due for another TTL.
  at(T0 + 6_000);
  expect((await denied(() => limiter.admit(keyId, limits, "req_after"))).code).toBe("RATE_LIMIT");
  expect(gates).toHaveLength(4);
  store.close();
});

/**
 * The delta list is emptied by a store read, so a store that cannot answer
 * leaves nothing emptying it.
 *
 * Unbounded growth is the visible half; the invisible half is that `cleanup`
 * never drops a key holding debits and `markEager` walks the whole list once per
 * debit, which is quadratic in the requests served during the fault.
 */
test("folding a delta list bounds it without lowering what it reports", () => {
  const now = T0 + ONE_WEEK;
  const debits: Debit[] = [
    // Older than the longest window, so no window can still count it. Absurd
    // figures, so dropping it shows up as a number rather than as a rounding.
    { at: now - ONE_WEEK - 1, requests: 1, tokens: 1_000_000, costUsd: 1_000 },
    ...Array.from({ length: MAX_DEBITS + 5_000 }, (_, i) => ({
      at: T0 + i,
      requests: 1,
      tokens: 10,
      costUsd: 0.01,
    })),
  ];

  const trimmed = trimDebits(debits, now);
  expect(trimmed.length).toBeLessThanOrEqual(MAX_DEBITS);
  expect(trimmed.some((debit) => debit.at < now - ONE_WEEK)).toBe(false);

  /** `sinceRead`'s arithmetic, restated so the property is checked against it. */
  const delta = (entries: readonly Debit[], readAt: number): number =>
    entries.reduce((sum, entry) => (entry.at < readAt ? sum : sum + entry.tokens), 0);

  // Instants a cached read could carry, sampled either side of the fold rather
  // than swept: the fold is where the two lists can differ, and a readAt inside
  // it is the only one that can differ downward. Folding may keep a
  // contribution in the delta longer than it belonged there — the direction
  // `sinceRead` already chooses — and may never drop one that still belongs.
  const cut = debits.length - MAX_DEBITS;
  for (const readAt of [
    now - ONE_WEEK,
    T0,
    T0 + 1,
    T0 + Math.floor(cut / 2),
    T0 + cut - 1,
    T0 + cut,
    T0 + cut + 1,
    T0 + debits.length - 1,
    T0 + debits.length,
    now,
  ]) {
    expect(delta(trimmed, readAt)).toBeGreaterThanOrEqual(delta(debits, readAt));
  }
  // And it is a fold rather than a discard: nothing inside the window is lost.
  expect(delta(trimmed, now - ONE_WEEK)).toBe(delta(debits, now - ONE_WEEK));
});

test("a store that cannot answer stops the delta list growing without bound", async () => {
  const { store, keyId, limiter, admit, at } = await harness({ tokens: { "5h": 1_000_000 } });
  store.usage.sumSince = async () => {
    throw new Error("database is locked");
  };

  at(T0);
  (await admit())();
  for (let i = 0; i < MAX_DEBITS + 500; i++) {
    at(T0 + i);
    limiter.debit(keyId, { tokens: 1, costUsd: 0 });
  }
  expect(limiter.pendingDebits(keyId)).toBeGreaterThan(MAX_DEBITS);

  at(T0 + MAX_DEBITS + 500);
  (await admit())();
  expect(limiter.pendingDebits(keyId)).toBeLessThanOrEqual(MAX_DEBITS);

  // A week on, every entry is outside every window and the key can be dropped
  // again rather than held for the life of the process.
  at(T0 + ONE_WEEK + FIVE_HOURS);
  (await admit())();
  expect(limiter.pendingDebits(keyId)).toBe(0);
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
