import { expect, test } from "bun:test";
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
  expect(rateLimiter.inFlight(keyId)).toBe(1);

  const second = await call(BODY);
  expect(second.status).toBe(429);

  await first.text();
  expect(rateLimiter.inFlight(keyId)).toBe(0);
  store.close();
});

test("frees the concurrency slot when a non-streaming request completes", async () => {
  const { store, call, rateLimiter, keyId } = await harness();
  const response = await call(BODY);
  expect(response.status).toBe(200);
  expect(rateLimiter.inFlight(keyId)).toBe(0);
  store.close();
});

test("frees the concurrency slot when a stream drains", async () => {
  const { store, call, rateLimiter, keyId } = await harness();
  const response = await call({ ...BODY, stream: true });
  expect(response.status).toBe(200);
  // Still held: the head is out, the request is not over.
  expect(rateLimiter.inFlight(keyId)).toBe(1);

  await response.text();
  expect(rateLimiter.inFlight(keyId)).toBe(0);
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
  expect(rateLimiter.inFlight(keyId)).toBe(0);
  store.close();
});

test("frees the concurrency slot when a request is refused before dispatch", async () => {
  const { store, call, rateLimiter, keyId } = await harness({ modelAllowlist: [] });
  const response = await call(BODY);
  expect(response.status).toBe(401);
  expect(rateLimiter.inFlight(keyId)).toBe(0);
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
    expect(rateLimiter.inFlight(keyId)).toBe(1);

    await reader.cancel();
    expect(rateLimiter.inFlight(keyId)).toBe(0);
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
  expect(rateLimiter.inFlight(keyId)).toBe(1);

  controller.abort();
  await reader.cancel().catch(() => undefined);
  expect(rateLimiter.inFlight(keyId)).toBe(0);
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

  expect(rateLimiter.inFlight(keyId)).toBe(0);
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
function trackTimers(): { live: () => number; restore: () => void } {
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
