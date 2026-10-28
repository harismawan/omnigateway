import { describe, expect, test } from "bun:test";
import { type Coord, memoryCoord } from "@omni/coord";
import type { StreamEvent } from "@omni/ir";
import type { HttpClient } from "@omni/providers";
import type { LimitConfig } from "@omni/ratelimit/catalog";
import { createPostgresStore, deriveKey, type Store } from "@omni/store";
import {
  captureLogger,
  memoryStore,
  seedApiKey,
  seedCredential,
  stubAdapters,
  target,
  virtualModel,
} from "@omni/testkit";
import { RedisClient, SQL } from "bun";
import { createApp } from "../../src/app.ts";
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

async function fleet(
  limits: LimitConfig,
  coords: Coords = shared,
  openStore: () => Promise<Store> = memoryStore,
) {
  const store = await openStore();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  const { raw } = await seedApiKey(store, { limits, modelAllowlist: null });
  const [coordA, coordB] = await coords();

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

/** Both replicas' coordinators, ready to claim against once this settles. */
type Coords = () => [Coord, Coord] | Promise<[Coord, Coord]>;

/** One in-memory coordinator handed to both replicas. */
function shared(): [Coord, Coord] {
  const coord = memoryCoord();
  return [coord, coord];
}

function suite(name: string, coords: Coords, openStore: () => Promise<Store> = memoryStore) {
  describe(name, () => {
    test("a concurrency ceiling holds across replicas", async () => {
      const { store, a, b, call } = await fleet({ concurrency: 1 }, coords, openStore);

      const held = await call(a, { ...BODY, stream: true });
      expect(held.status).toBe(200);

      expect((await call(b, BODY)).status).toBe(429);

      await held.text();
      expect((await call(b, BODY)).status).toBe(200);
      store.close();
    });

    test("a per-minute request ceiling holds across replicas", async () => {
      const { store, a, b, call } = await fleet({ requests: { "1m": 2 } }, coords, openStore);

      expect((await call(a, BODY)).status).toBe(200);
      expect((await call(b, BODY)).status).toBe(200);
      expect((await call(b, BODY)).status).toBe(429);
      expect((await call(a, BODY)).status).toBe(429);
      store.close();
    });

    test("a long window holds across replicas", async () => {
      const { store, a, b, call } = await fleet({ requests: { "5h": 2 } }, coords, openStore);

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
const twoRedis = async (): Promise<[Coord, Coord]> => {
  const db = `${(url ?? "").replace(/\/\d+$/, "")}/14`;
  const admin = new RedisClient(db);
  // Awaited. Sent and left to land whenever, the flush raced the suite's own
  // first claims: landing after them it erased the ring stamps the ceiling is
  // counted from, and a per-minute ceiling of two admitted a third request —
  // observed once under a full-suite run, reproduced every time by delaying
  // the flush 60ms. A flake shaped exactly like the bug this file exists to
  // catch is a guard that teaches people to rerun it.
  try {
    await admin.send("FLUSHDB", []);
  } finally {
    admin.close();
  }
  return [redisCoord({ url: db }), redisCoord({ url: db })];
};
if (url !== undefined) suite("two replicas over two redis coords", twoRedis);

/**
 * The deployment itself: two replicas, two Redis coordinators, one Postgres.
 * Every earlier suite proves a slice; this one proves the request path over
 * exactly the parts a fleet runs on. Skipped without both services; CI has both.
 */
const pg = process.env.OMNI_TEST_DATABASE_URL;
if (url !== undefined && pg !== undefined) {
  test("prompt writes fan out across real nodes; external SQL on both tables bumps config version", async () => {
    const sql = new SQL({ url: pg, max: 1 });
    await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    const encryptionKey = await deriveKey("test-encryption-key-0123456789");
    const a = await createPostgresStore({ url: pg, encryptionKey });
    const b = await createPostgresStore({ url: pg, encryptionKey });
    const [coordA, coordB] = await twoRedis();
    try {
      const messages: string[] = [];
      coordB.pubsub.subscribe("routing", (_topic, payload) => messages.push(payload));
      await seedCredential(a, { id: "c1", provider: "anthropic" });
      await a.config.putModel(
        virtualModel({
          id: "fast",
          targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
        }),
      );
      const holder = await seedApiKey(a);
      const seen: string[] = [];
      const adapters = stubAdapters(EVENTS);
      const adapter = adapters.anthropic;
      if (!adapter) throw new Error("missing stub");
      const send = adapter.send;
      adapter.send = (opts) => {
        seen.push(
          opts.request.system?.map((p) => (p.type === "text" ? p.text : "")).join("\n") ?? "",
        );
        return send(opts);
      };
      const appA = createApp({
        store: a,
        coord: coordA,
        nodeId: "prompt-a",
        baseUrl: "http://localhost",
        now: () => NOW,
      });
      // Pin version(): this test must fail without pubsub even though PG's
      // independent read-behind version check can eventually rescue a node.
      const appB = createApp({
        store: { ...b, routing: { ...b.routing, version: () => 0 } },
        coord: coordB,
        nodeId: "prompt-b",
        baseUrl: "http://localhost",
        now: () => NOW,
        adapters,
      });
      const api = (method: string, path: string, body?: unknown, cookie = "") =>
        appA.handle(
          new Request(`http://localhost${path}`, {
            method,
            headers: { "content-type": "application/json", cookie },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const login = await api("POST", "/api/setup", { password: "hunter2hunter2" });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const infer = async () => {
        const res = await appB.handle(
          new Request("http://localhost/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${holder.raw}` },
            body: JSON.stringify(BODY),
          }),
        );
        expect(res.status).toBe(200);
        await res.text();
        return seen.at(-1);
      };
      expect(await infer()).toBe("");
      expect(
        (
          await api(
            "POST",
            "/api/prompts",
            { id: "team", name: "Team", text: "one", activate: true },
            cookie,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await api(
            "PUT",
            "/api/settings",
            { ...(await a.config.getSettings()), prompts: ["team"] },
            cookie,
          )
        ).status,
      ).toBe(200);
      const until = async (text: string) => {
        for (let n = 0; n < 100; n++) {
          if ((await infer()) === text) return;
          await Bun.sleep(10);
        }
        expect(messages).toContainEqual(expect.stringContaining("settingsChanged"));
        expect(seen.at(-1)).toBe(text);
      };
      await until("one");
      expect(
        (await api("POST", "/api/prompts/team/versions", { text: "two", activate: true }, cookie))
          .status,
      ).toBe(200);
      await until("two");
      expect((await api("PUT", "/api/prompts/team/active", { version: 1 }, cookie)).status).toBe(
        200,
      );
      await until("one");
      expect(
        (
          await api(
            "PUT",
            `/api/keys/${holder.key.id}/prompts`,
            { ids: [], inheritGlobal: false },
            cookie,
          )
        ).status,
      ).toBe(200);
      await until("");
      // Raw writes cannot emit local events. Verify each migration trigger on
      // its own by reading the authoritative counter before/after the write.
      const version = async () =>
        Number((await sql.unsafe("SELECT version FROM config_version WHERE id = 1"))[0].version);
      for (const statement of [
        "UPDATE prompts SET name = 'External' WHERE id = 'team'",
        "UPDATE prompt_versions SET text = 'external text' WHERE prompt_id = 'team' AND version = 1",
      ]) {
        const before = await version();
        await sql.unsafe(statement);
        expect(await version()).toBeGreaterThan(before);
      }
    } finally {
      a.close();
      b.close();
      await sql.close();
    }
  });
  suite("two replicas over redis and postgres", twoRedis, async () => {
    const admin = new SQL({ url: pg, max: 1 });
    try {
      await admin.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    } finally {
      await admin.close();
    }
    return createPostgresStore({
      url: pg,
      encryptionKey: await deriveKey("test-encryption-key-0123456789"),
    });
  });
}
