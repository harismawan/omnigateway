import { describe, expect, test } from "bun:test";
import { type Coord, memoryCoord } from "@omni/coord";
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
import { RedisClient } from "bun";
import { redisCoord } from "../../src/coord/redis.ts";
import { proxyRoutes } from "../../src/routes/proxy.ts";

/**
 * Two gateway processes serving one installation, stood up as two route
 * trees over one store and one `Coord` — no Redis, no second process.
 *
 * This is the instrument for the class of bug this repository repeats most: a
 * counter threaded into some of the call graph and not all. A site still
 * reading a module-scope map sees replica A's state and fails here, whichever
 * site it is, because the request that should be refused arrives at B.
 */

const NOW = 1_000_000;

const EVENTS: StreamEvent[] = [
  { type: "start", id: "upstream_1", model: "claude-opus-4" },
  { type: "blockStart", index: 0, block: { type: "text" } },
  { type: "blockDelta", index: 0, delta: { type: "text", text: "Hi" } },
  { type: "blockEnd", index: 0 },
  {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

const BODY = { model: "fast", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

async function fleet(limits: LimitConfig, coords: () => [Coord, Coord] = shared) {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  const { raw } = await seedApiKey(store, { limits, modelAllowlist: null });
  const [coordA, coordB] = coords();

  let n = 0;
  const replica = (coord: Coord) =>
    proxyRoutes({
      store,
      coord,
      adapters: stubAdapters(EVENTS),
      http: (() => {
        throw new Error("a stub adapter reached the transport");
      }) as HttpClient,
      now: () => NOW,
      rand: () => 0.5,
      refresh: async (credential) => await credential.secrets(),
      requestId: () => `req_${++n}`,
      logger: captureLogger(),
    });

  const call = (app: ReturnType<typeof replica>, body: unknown) =>
    app.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
        body: JSON.stringify(body),
      }),
    );

  return { store, a: replica(coordA), b: replica(coordB), call };
}

/** One in-memory coordinator handed to both replicas. */
function shared(): [Coord, Coord] {
  const coord = memoryCoord();
  return [coord, coord];
}

function suite(name: string, coords: () => [Coord, Coord]) {
  describe(name, () => {
    test("a concurrency ceiling holds across replicas", async () => {
      const { store, a, b, call } = await fleet({ concurrency: 1 }, coords);

      const held = await call(a, { ...BODY, stream: true });
      expect(held.status).toBe(200);

      expect((await call(b, BODY)).status).toBe(429);

      await held.text();
      expect((await call(b, BODY)).status).toBe(200);
      store.close();
    });

    test("a per-minute request ceiling holds across replicas", async () => {
      const { store, a, b, call } = await fleet({ requests: { "1m": 2 } }, coords);

      expect((await call(a, BODY)).status).toBe(200);
      expect((await call(b, BODY)).status).toBe(200);
      expect((await call(b, BODY)).status).toBe(429);
      expect((await call(a, BODY)).status).toBe(429);
      store.close();
    });

    test("a long window holds across replicas", async () => {
      const { store, a, b, call } = await fleet({ requests: { "5h": 2 } }, coords);

      expect((await call(a, BODY)).status).toBe(200);
      expect((await call(b, BODY)).status).toBe(200);
      // Debits land on completion; a moment for the second one to settle.
      await Bun.sleep(20);
      expect((await call(a, BODY)).status).toBe(429);
      store.close();
    });
  });
}

suite("two replicas over one memory coord", shared);

/**
 * The same three, over two *separate* Redis-backed coordinators — which is
 * what two pods actually hold. Skipped without a Redis to hand; CI names one.
 */
const url = process.env.OMNI_TEST_REDIS_URL;
if (url !== undefined) {
  const base = url.replace(/\/\d+$/, "");
  suite("two replicas over two redis coords", () => {
    const db = `${base}/14`;
    const admin = new RedisClient(db);
    void admin.send("FLUSHDB", []).finally(() => admin.close());
    return [redisCoord({ url: db }), redisCoord({ url: db })];
  });
}
