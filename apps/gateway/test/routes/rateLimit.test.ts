import { expect, test } from "bun:test";
import { memoryCoord } from "@omni/coord";
import type { StreamEvent } from "@omni/ir";
import type { HttpClient } from "@omni/providers";
import type { LimitConfig } from "@omni/ratelimit/catalog";
import {
  captureLogger,
  memoryStore,
  seedApiKey,
  seedCredential,
  stubAdapters,
  target,
  virtualModel,
} from "@omni/testkit";
import { ApiKeyRateLimiter } from "../../src/auth/rateLimit.ts";
import { type ProxyDeps, proxyRoutes } from "../../src/routes/proxy.ts";

const NOW = 1_000_000;

const EVENTS: StreamEvent[] = [
  { type: "start", id: "upstream_1", model: "claude-opus-4" },
  { type: "blockStart", index: 0, block: { type: "text" } },
  { type: "blockDelta", index: 0, delta: { type: "text", text: "Hi" } },
  { type: "blockEnd", index: 0 },
  {
    type: "end",
    stopReason: "endTurn",
    // All four token classes carry a distinct figure, because they are disjoint
    // and a debit that reached for only some of them must read low here rather
    // than agree by coincidence.
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 3 },
  },
];

type HarnessOptions = {
  limits?: LimitConfig;
  events?: StreamEvent[];
  now?: () => number;
  overrides?: Partial<ProxyDeps>;
  modelAllowlist?: string[] | null;
};

async function harness(options: HarnessOptions = {}) {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  const { raw, key } = await seedApiKey(store, {
    limits: options.limits ?? { concurrency: 4 },
    modelAllowlist: options.modelAllowlist ?? null,
  });
  const logger = captureLogger();
  const now = options.now ?? (() => NOW);
  const rateLimiter = new ApiKeyRateLimiter({ store, now, logger });
  const debits: Array<{ keyId: string; tokens: number; costUsd: number }> = [];
  const debit = rateLimiter.debit.bind(rateLimiter);
  rateLimiter.debit = (keyId, usage) => {
    debits.push({ keyId, tokens: usage.tokens, costUsd: usage.costUsd });
    debit(keyId, usage);
  };

  let n = 0;
  const app = proxyRoutes({
    store,
    adapters: stubAdapters(options.events ?? EVENTS),
    http: (() => {
      throw new Error("a stub adapter reached the transport");
    }) as HttpClient,
    now,
    rand: () => 0.5,
    refresh: async (credential) => await credential.secrets(),
    requestId: () => `req_${++n}`,
    rateLimiter,
    logger,
    ...options.overrides,
  });

  const call = (body: unknown, init: RequestInit = {}) =>
    app.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
        body: JSON.stringify(body),
        ...init,
      }),
    );

  return { store, app, raw, keyId: key.id, rateLimiter, logger, debits, call };
}

const BODY = { model: "fast", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

test("a concurrency ceiling refuses the request that would exceed it", async () => {
  const { store, call, rateLimiter, keyId } = await harness({
    limits: { concurrency: 1 },
    events: EVENTS,
  });

  // Both in flight at once: the first is held at its first pull, so the second
  // is judged while the gauge is up.
  const first = await call({ ...BODY, stream: true });
  expect(first.status).toBe(200);
  expect(await rateLimiter.inFlight(keyId)).toBe(1);

  const second = await call(BODY);
  expect(second.status).toBe(429);

  await first.text();
  expect(await rateLimiter.inFlight(keyId)).toBe(0);
  store.close();
});

test("frees the concurrency slot when a non-streaming request completes", async () => {
  const { store, call, rateLimiter, keyId } = await harness();
  const response = await call(BODY);
  expect(response.status).toBe(200);
  expect(await rateLimiter.inFlight(keyId)).toBe(0);
  store.close();
});

test("frees the concurrency slot when a stream drains", async () => {
  const { store, call, rateLimiter, keyId } = await harness();
  const response = await call({ ...BODY, stream: true });
  expect(response.status).toBe(200);
  // Still held: the head is out, the request is not over.
  expect(await rateLimiter.inFlight(keyId)).toBe(1);

  await response.text();
  expect(await rateLimiter.inFlight(keyId)).toBe(0);
  store.close();
});

/**
 * The ceiling holds for a request that outlives the slot's TTL.
 *
 * `GAUGE_TTL_MS` expires a live holder as readily as a dead one, and
 * `requestDeadlineMs` is `0` by default, so nothing keeps a request under it.
 * `admit` therefore names the slot and renews it on a timer. This drives that
 * timer directly rather than waiting five real minutes: the renewal is what
 * must keep `inFlight` at one and keep the second request refused.
 *
 * Asserted through `admit` rather than the gauge because the defect was in
 * what the limiter *does* with the gauge — an unnamed slot cannot be renewed
 * at all, so this fails outright on the previous code.
 */
test("a request outliving the slot ttl keeps its concurrency slot", async () => {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, { limits: { concurrency: 1 } });
  let clock = NOW;
  const now = () => clock;
  const limiter = new ApiKeyRateLimiter({
    store,
    now,
    logger: captureLogger(),
    // The coord must share this clock. Its default is `Date.now()`, which
    // ignores the steps below entirely and makes the whole test vacuous — the
    // slot never reaches its expiry and every assertion passes for the wrong
    // reason.
    coord: memoryCoord({ now }),
  });
  const limits: LimitConfig = { concurrency: 1 };

  const admission = await limiter.admit(key.id, limits, "req-long");
  expect(await limiter.inFlight(key.id)).toBe(1);

  // The renewal fires every `RENEW_INTERVAL_MS` — a third of the TTL — so it
  // always lands on a slot that is still live. Stepping past the expiry first
  // would test the opposite rule: `renew` must NOT resurrect a lapsed slot,
  // and would report a no-op as a broken ceiling.
  const RENEW_INTERVAL = 100_000;
  const TTL = 300_000;
  // Twelve intervals is twenty minutes, four TTLs deep: without renewal the
  // slot would have lapsed three times over.
  for (let i = 0; i < 12; i++) {
    clock += RENEW_INTERVAL;
    // Exactly what the interval callback inside `admit` does.
    await admission.renew();
    expect(await limiter.inFlight(key.id)).toBe(1);
  }
  expect(clock - NOW).toBeGreaterThan(TTL * 3);

  // A rival is still refused, which is the promise `concurrency` makes.
  await expect(limiter.admit(key.id, limits, "req-rival")).rejects.toThrow();
  expect(await limiter.inFlight(key.id)).toBe(1);

  // And the long request's own release still frees exactly its slot.
  admission.release();
  expect(await limiter.inFlight(key.id)).toBe(0);

  // Renewal after release is inert: the slot is gone and must not come back as
  // a holder nothing will ever release.
  await admission.renew();
  expect(await limiter.inFlight(key.id)).toBe(0);
  store.close();
});

/**
 * The renewal above is driven by hand, so this asserts the wiring separately:
 * that `admit` starts a timer, that the release stops it, and that it is
 * unrefed so it can never be the thing holding the process open.
 *
 * Without this the pair of tests would pass on code that renews correctly when
 * asked and never asks.
 */
test("admit runs an unrefed renewal timer, and the release clears it", async () => {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, { limits: { concurrency: 1 } });
  const started: Array<{ ms: number; unrefed: boolean; fire: () => void }> = [];
  let cleared = 0;

  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    const timer = realSet(fn, ms);
    const entry = { ms: ms ?? 0, unrefed: false, fire: fn };
    started.push(entry);
    // `unref` is what the production call reaches for; record that it was.
    const withUnref = timer as unknown as { unref?: () => unknown };
    const priorUnref = withUnref.unref?.bind(timer);
    withUnref.unref = () => {
      entry.unrefed = true;
      return priorUnref?.() ?? timer;
    };
    return timer;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((timer: Parameters<typeof realClear>[0]) => {
    cleared += 1;
    return realClear(timer);
  }) as typeof globalThis.clearInterval;

  try {
    let clock = NOW;
    const now = () => clock;
    const limiter = new ApiKeyRateLimiter({
      store,
      now,
      logger: captureLogger(),
      coord: memoryCoord({ now }),
    });
    const admission = await limiter.admit(key.id, { concurrency: 1 }, "req-1");
    expect(started).toHaveLength(1);
    expect(started[0]?.ms).toBe(100_000);
    expect(started[0]?.unrefed).toBe(true);
    expect(cleared).toBe(0);

    // Fire the captured callback rather than trusting that it renews: this is
    // the difference between "a timer exists" and "the timer does the work".
    // Stepped by the renewal interval, so the callback always lands on a live
    // slot — stepping past the TTL first would test the opposite rule (renew
    // must not revive a lapsed slot) and read a correct no-op as a failure.
    for (let i = 0; i < 5; i++) {
      clock += 100_000;
      started[0]?.fire();
      await Promise.resolve();
    }
    // Past the TTL in total, so an un-renewed slot would be long gone.
    expect(clock - NOW).toBeGreaterThan(300_000);
    expect(await limiter.inFlight(key.id)).toBe(1);

    admission.release();
    expect(cleared).toBe(1);
    // Idempotent: a second release clears nothing further.
    admission.release();
    expect(cleared).toBe(1);

    // A key with no concurrency ceiling starts no timer at all.
    await (await limiter.admit(key.id, { requests: { "1m": 5 } }, "req-2")).release();
    expect(started).toHaveLength(1);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    store.close();
  }
});

/**
 * Renewal is bounded, so a slot whose release never runs still heals.
 *
 * The TTL is the only thing that reclaims a leaked slot — a streaming
 * `Response` nobody reads is the reachable case — so a timer that renewed
 * forever would turn a five-minute leak into a permanent one and lock the key's
 * ceiling for the life of the process. Past `MAX_RENEWED_MS` the timer stops
 * renewing and clears itself, and the slot lapses on its own.
 */
test("renewal stops at the cap, so an abandoned slot lapses instead of leaking forever", async () => {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, { limits: { concurrency: 1 } });
  const fired: Array<() => void> = [];
  let cleared = 0;

  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void) => {
    fired.push(fn);
    return realSet(() => {}, 1 << 30);
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((timer: Parameters<typeof realClear>[0]) => {
    cleared += 1;
    return realClear(timer);
  }) as typeof globalThis.clearInterval;

  try {
    let clock = NOW;
    const now = () => clock;
    const limiter = new ApiKeyRateLimiter({
      store,
      now,
      logger: captureLogger(),
      coord: memoryCoord({ now }),
    });
    // Admitted and then abandoned: nothing ever calls `release`.
    await limiter.admit(key.id, { concurrency: 1 }, "abandoned");
    expect(await limiter.inFlight(key.id)).toBe(1);

    const DAY = 86_400_000;
    // Renewed on its real interval all the way to the cap, so the slot is
    // continuously live rather than lapsing between steps.
    while (clock + 100_000 < NOW + DAY) {
      clock += 100_000;
      fired[0]?.();
      await Promise.resolve();
    }
    expect(await limiter.inFlight(key.id)).toBe(1);
    expect(cleared).toBe(0);

    // At the cap it stops renewing and clears itself.
    clock = NOW + DAY;
    fired[0]?.();
    await Promise.resolve();
    expect(cleared).toBe(1);

    // One TTL later, with nothing renewing it, the slot is gone and the
    // ceiling admits again — the pre-renewal behaviour, restored.
    clock = NOW + DAY + 300_001;
    expect(await limiter.inFlight(key.id)).toBe(0);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    store.close();
  }
});

/**
 * The slot's name is the limiter's, never the caller's `requestId`.
 *
 * A named slot is idempotent on purpose, so if the name came from the caller,
 * two requests handed one id would share a single slot and the ceiling would
 * admit past itself — a limit that under-counts, which is worse than no limit
 * because the operator believes they set one. The burst tests in
 * `test/auth/rateLimit.test.ts` caught exactly this by passing one id eight
 * times; this states the rule where the name is chosen.
 */
test("one requestId reused across admissions still holds one slot each", async () => {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, { limits: { concurrency: 3 } });
  const limiter = new ApiKeyRateLimiter({ store, now: () => NOW, logger: captureLogger() });
  const limits: LimitConfig = { concurrency: 3 };

  // Same id every time, which is what a buggy caller or a retry looks like.
  const first = await limiter.admit(key.id, limits, "same-id");
  const second = await limiter.admit(key.id, limits, "same-id");
  expect(await limiter.inFlight(key.id)).toBe(2);

  const third = await limiter.admit(key.id, limits, "same-id");
  expect(await limiter.inFlight(key.id)).toBe(3);
  // The ceiling still bites at three.
  await expect(limiter.admit(key.id, limits, "same-id")).rejects.toThrow();

  // Each release frees exactly one, so the count walks down rather than
  // collapsing to zero on the first.
  first.release();
  expect(await limiter.inFlight(key.id)).toBe(2);
  second.release();
  expect(await limiter.inFlight(key.id)).toBe(1);
  third.release();
  expect(await limiter.inFlight(key.id)).toBe(0);
  store.close();
});

test("frees the concurrency slot when the gateway deadline expires", async () => {
  // Every read advances the clock, so the deadline is passed at the top of the
  // attempt loop without waiting for a timer — the shape the dispatch deadline
  // tests use, and the one that keeps a gateway timeout distinct from a client
  // hanging up.
  let clock = NOW;
  const { store, call, rateLimiter, keyId } = await harness({
    now: () => {
      clock += 5;
      return clock;
    },
  });
  await store.config.putSettings({ requestDeadlineMs: 10 });

  const response = await call(BODY);
  expect(response.status).toBe(504);
  expect(await rateLimiter.inFlight(keyId)).toBe(0);
  store.close();
});

test("frees the concurrency slot when a request is refused before dispatch", async () => {
  const { store, call, rateLimiter, keyId } = await harness({ modelAllowlist: [] });
  const response = await call(BODY);
  expect(response.status).toBe(401);
  expect(await rateLimiter.inFlight(keyId)).toBe(0);
  store.close();
});

/**
 * The failure this design fears most, and the one that says nothing when it
 * happens: no window expires a gauge, so a slot leaked by a disconnect locks
 * the key out permanently.
 *
 * The decrement therefore cannot live beside the debit — a client that hangs up
 * mid-stream never reaches it — nor in a `finally` around the handler body,
 * which fires when the head is sent. It rides `sseResponse`'s run-once
 * completion, which is the only site all three stream endings pass through.
 */
test("frees the concurrency slot when a client hangs up mid-stream, leaving no timer behind", async () => {
  const { store, call, rateLimiter, keyId } = await harness();
  const timers = trackTimers();
  try {
    const response = await call({ ...BODY, stream: true });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("expected a streamed body");
    await reader.read();
    expect(await rateLimiter.inFlight(keyId)).toBe(1);

    await reader.cancel();
    expect(await rateLimiter.inFlight(keyId)).toBe(0);
    // Before `restore`, which uninstalls the patched `clearTimeout` and so
    // freezes the set. The keepalive timer is cleared in a `.finally` that runs
    // after the cancel resolves.
    await timers.settle();
  } finally {
    timers.restore();
  }
  expect(timers.live()).toBe(0);
  store.close();
});

test("frees the concurrency slot when a client aborts a stream, leaving no listener behind", async () => {
  const { store, call, rateLimiter, keyId } = await harness();
  const controller = new AbortController();
  const listeners = trackAbortListeners(controller.signal);

  const response = await call({ ...BODY, stream: true }, { signal: controller.signal });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("expected a streamed body");
  await reader.read();
  expect(await rateLimiter.inFlight(keyId)).toBe(1);

  controller.abort();
  await reader.cancel().catch(() => undefined);
  expect(await rateLimiter.inFlight(keyId)).toBe(0);
  expect(listeners.live()).toBe(0);
  store.close();
});

/**
 * The gauge must not depend on the store, because a leaked slot is the one
 * failure here that nothing recovers from: no window expires it, and after N of
 * them the key is locked out until the process restarts.
 *
 * A row write that never returns is the cheapest way to state that. Freeing the
 * slot beside the debit — which is on the far side of `usage.append` — strands
 * it here; freeing it at the end of the stream does not.
 */
test("a row write that never returns does not strand the concurrency slot", async () => {
  const { store, call, rateLimiter, keyId } = await harness();
  store.usage.append = () => new Promise<void>(() => {});

  const response = await call({ ...BODY, stream: true });
  await response.text();

  expect(await rateLimiter.inFlight(keyId)).toBe(0);
  store.close();
});

/**
 * That the route asks the limiter at all, which `consume`'s own tests cannot
 * say.
 *
 * Every assertion about this dimension sits on `ApiKeyRateLimiter.consume`,
 * called directly — so deleting the call site in the route leaves the whole
 * suite green and makes `count_tokens` the one `/v1` surface a key may hammer
 * without a ceiling. It is also the surface a client polls hardest: Claude Code
 * paces its own compaction with it.
 */
test("count_tokens is refused once the key's requests ceiling is reached", async () => {
  const { store, app, raw } = await harness({ limits: { requests: { "1m": 2 } } });
  const count = () =>
    app.handle(
      new Request("http://localhost/v1/messages/count_tokens", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
        body: JSON.stringify(BODY),
      }),
    );

  const first = await count();
  expect(first.status).toBe(200);
  // The route still answers what it is for, so a 429 below is the ceiling and
  // not the estimate having broken.
  expect(await first.json()).toEqual({ input_tokens: expect.any(Number) as number });
  expect((await count()).status).toBe(200);

  const refused = await count();
  expect(refused.status).toBe(429);
  // The whole minute, from the oldest of the two stamps in the ring. Said on a
  // header rather than only in a body no SDK reads.
  expect(refused.headers.get("retry-after")).toBe("60");
  store.close();
});

test("debits a finished request's tokens and cost exactly once", async () => {
  const { store, call, debits, keyId } = await harness();
  const response = await call(BODY);
  await response.text();

  expect(debits).toEqual([{ keyId, tokens: 20, costUsd: 0.00036375 }]);
  store.close();
});

test("debits a streamed request once, after the stream drains", async () => {
  const { store, call, debits, keyId } = await harness();
  const response = await call({ ...BODY, stream: true });
  expect(debits).toEqual([]);

  await response.text();
  expect(debits).toEqual([{ keyId, tokens: 20, costUsd: 0.00036375 }]);
  store.close();
});

/**
 * A response the row was already written for, and which then throws on the way
 * out. The terminal catch takes it with `logged` already true, so `finishLog`
 * does not run again — and neither, therefore, does the debit that hangs off
 * it. This is the guarantee the debit inherits rather than re-establishes.
 */
test("does not debit twice when a request fails after its row was completed", async () => {
  const unserializable: StreamEvent[] = [
    { type: "start", id: "upstream_1", model: "claude-opus-4" },
    {
      type: "blockStart",
      index: 0,
      block: {
        type: "providerNative",
        provider: "anthropic",
        blockType: "web_search_tool_result",
        // The one JSON type there is no encoding for, so this throws in
        // `JSON.stringify` and nowhere earlier.
        data: { queriedAt: 1n },
      },
    },
    { type: "blockEnd", index: 0 },
    {
      type: "end",
      stopReason: "endTurn",
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 3 },
    },
  ];
  const { store, call, debits, keyId } = await harness({ events: unserializable });

  const response = await call(BODY);
  await response.text().catch(() => undefined);

  expect(response.status).toBe(500);
  expect(debits).toEqual([{ keyId, tokens: 20, costUsd: 0.00036375 }]);
  store.close();
});

/**
 * The boundary the debit's placement buys. It hangs off the gateway's own
 * `finishLog`, not off `usage.append`, so a second append — a restore, a
 * backfill, anything else holding the store — moves rows and moves no counter.
 */
test("a second usage.append debits nothing, because the debit is not in the store", async () => {
  const { store, call, debits } = await harness();
  const response = await call(BODY);
  await response.text();
  expect(debits).toHaveLength(1);

  const rows = await store.usage.recent(10);
  const row = rows[0];
  if (row === undefined) throw new Error("expected the request to have been logged");
  await store.usage.append(row);

  expect(debits).toHaveLength(1);
  store.close();
});

type Timer = ReturnType<typeof setTimeout>;

/**
 * Every timer made while the audit is installed, minus the ones cleared or
 * fired.
 *
 * `process.getActiveResourcesInfo()` returns an empty array under Bun, so the
 * only way to see a timer nobody cleaned up is to watch the two calls that make
 * and unmake one.
 */
function trackTimers(): {
  live: () => number;
  settle: (timeoutMs?: number) => Promise<void>;
  restore: () => void;
} {
  const live = new Set<Timer>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  const patchedSetTimeout = (
    handler: (...args: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ): Timer => {
    const slot: { id?: Timer } = {};
    slot.id = realSetTimeout(() => {
      if (slot.id !== undefined) live.delete(slot.id);
      handler(...rest);
    }, ms);
    live.add(slot.id);
    return slot.id;
  };
  const patchedClearTimeout = (id?: Timer): void => {
    if (id !== undefined) live.delete(id);
    realClearTimeout(id);
  };

  globalThis.setTimeout = patchedSetTimeout as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = patchedClearTimeout as unknown as typeof globalThis.clearTimeout;

  return {
    live: () => live.size,
    /**
     * Waits for outstanding cleanup to land, and must be called before
     * `restore`.
     *
     * The set only ever shrinks through `patchedClearTimeout`, so `restore`
     * uninstalling it makes every later clear invisible here — a timer cleared
     * one microtask after the assertion counts as leaked forever. The teardown
     * this test cares about is exactly that late: `withKeepalive` clears its
     * timer in a `.finally` on the race, which is a microtask that runs after
     * `reader.cancel()` resolves, so asserting straight after the cancel is
     * racing the code under test rather than checking it.
     *
     * Bounded rather than a fixed wait, and polled on `realSetTimeout` so the
     * poll's own timers never enter the set. This is not a way to make the
     * assertion pass: a genuinely leaked keepalive lives for `KEEPALIVE_MS`
     * (10s), so it is still counted when this gives up and the assertion still
     * fails.
     *
     * The bound must stay under the keepalive for that to hold, and far enough
     * over the real cleanup for the give-up not to be a verdict of its own. It
     * was 2s, and the whole-suite run is where that is too tight: observed
     * failing once at 2031ms — the deadline, not a leak — while passing 21/21
     * in isolation and under sibling load. A bound that reports a leak because
     * the machine was busy is a bound that teaches people to rerun the suite.
     *
     * "Under the keepalive" is `KEEPALIVE_MS` (10s) only because this harness
     * calls `/v1/messages`. `RESPONSES_KEEPALIVE_MS` is 4s, which is *below*
     * this bound: point a leak test at `/v1/responses` and the leaked timer
     * fires on its own before the deadline, so the assertion passes over a real
     * leak. Any surface added here needs its own keepalive checked against this
     * number, not this number assumed safe.
     */
    async settle(timeoutMs = 5_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (live.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => realSetTimeout(resolve, 1));
      }
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

type AbortListener = Parameters<AbortSignal["addEventListener"]>[1];

/**
 * Abort listeners added to one signal and not removed.
 *
 * A `{ once: true }` listener that fired is gone whether or not anything
 * removed it, so it is discounted when it runs; anything still counted after
 * the request is a listener the gateway attached and left.
 */
function trackAbortListeners(signal: AbortSignal): { live: () => number } {
  const held = new Map<AbortListener, { wrapper: EventListener; counted: boolean }>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  // Discounted once, whichever comes first: a `{ once: true }` listener that
  // fires is gone, and the site that added it may still remove it afterwards.
  const discount = (listener: AbortListener): void => {
    const entry = held.get(listener);
    if (entry !== undefined) entry.counted = false;
  };

  signal.addEventListener = (
    type: string,
    listener: AbortListener,
    options?: boolean | AddEventListenerOptions,
  ): void => {
    const once = typeof options === "object" && options.once === true;
    const wrapper: EventListener = (event) => {
      if (once) discount(listener);
      if (typeof listener === "function") listener(event);
      else listener?.handleEvent(event);
    };
    held.set(listener, { wrapper, counted: true });
    add(type, wrapper, options);
  };
  signal.removeEventListener = (type: string, listener: AbortListener): void => {
    const entry = held.get(listener);
    if (entry === undefined) return;
    discount(listener);
    remove(type, entry.wrapper);
  };

  return {
    live: () => [...held.values()].filter((entry) => entry.counted).length,
  };
}
